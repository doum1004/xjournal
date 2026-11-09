import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbHandle } from '@xjournal/db';
import { createTestDb } from '@xjournal/db/testing';
import { type Seed, seed } from '../../db/test/fixtures';
import {
  addNote,
  type Ctx,
  createProject,
  editNote,
  getRecord,
  initLocal,
  listInbox,
  listProjects,
  listRevisions,
  localOwner,
  routeRecord,
  ServiceError,
  search,
} from '../src';

// Workspace W is in America/New_York. 03:00 UTC on Nov 8 is still Nov 7 there.
const NOW = new Date('2026-11-08T03:00:00Z');
const TODAY = '2026-11-07';

let h: DbHandle;
let s: Seed;
const ctx = (user: keyof Seed['u'], ws: keyof Seed['ws'] = 'W'): Ctx => ({
  db: h.db,
  actor: { userId: s.u[user], workspaceId: s.ws[ws] },
});

async function fails(p: Promise<unknown>, status: number, code?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).status).toBe(status);
  if (code) expect((err as ServiceError).code).toBe(code as ServiceError['code']);
}

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
});
afterAll(() => h.close());

describe('projects', () => {
  test('the workspace owner creates a project and owns it', async () => {
    const p = await createProject(ctx('alice'), { slug: 'sdk', name: 'SDK' });
    expect(p).toMatchObject({ slug: 'sdk', role: 'owner', timeZone: 'America/New_York' });
    const mine = await listProjects(ctx('alice'));
    expect(mine.map((x) => x.slug)).toContain('sdk');
  });

  test('duplicate slugs conflict; bad input is a 400', async () => {
    await fails(createProject(ctx('alice'), { slug: 'sdk', name: 'Again' }), 409, 'conflict');
    await fails(createProject(ctx('alice'), { slug: 'Bad Slug', name: 'x' }), 400, 'bad_request');
    await fails(createProject(ctx('alice'), { slug: 'tz', name: 'x', timeZone: 'Mars/Base' }), 400);
  });

  test('someone who does not own the workspace cannot create one', async () => {
    await fails(createProject(ctx('bob'), { slug: 'bobs', name: 'Bob' }), 403, 'forbidden_role');
  });
});

describe('notes', () => {
  test('a note without hints lands in the Inbox, private, dated today in the workspace zone', async () => {
    const { note, routed } = await addNote(ctx('alice'), { text: 'Call the vendor' }, 'cli', NOW);
    expect(routed).toBe(false);
    expect(note).toMatchObject({
      kind: 'note',
      source: 'note',
      tier: 'manual',
      title: 'Call the vendor',
      projectId: null,
      routingStatus: 'needs_review',
      noteKind: 'event',
      visibility: 'private',
      applicableDate: TODAY,
      revisionNo: 1,
      isMine: true,
      owner: { id: s.u.alice, name: 'alice' },
    });
    expect(note.enteredAt).toBe(NOW.toISOString());
  });

  test('hints route the note, set its date, kind and tags', async () => {
    const { note, routed } = await addNote(
      ctx('alice'),
      { text: 'Fixed the flaky build #p @yesterday !decision !win\nRoot cause was a stale cache.' },
      'cli',
      NOW,
    );
    expect(routed).toBe(true);
    expect(note).toMatchObject({
      projectId: s.p.P,
      routingStatus: 'confirmed',
      applicableDate: '2026-11-06',
      noteKind: 'event',
      tags: ['decision', 'win'],
      title: 'Fixed the flaky build',
      summary: 'Fixed the flaky build\nRoot cause was a stale cache.',
      // The project's default note visibility (private, schema default).
      visibility: 'private',
    });
    const [rev] = await listRevisions(ctx('alice'), note.id);
    expect(rev?.payload.text).toBe(
      'Fixed the flaky build #p @yesterday !decision !win\nRoot cause was a stale cache.',
    );
    expect(rev?.payload.hints).toMatchObject({ projects: ['p'], date: '2026-11-06' });
  });

  test('only event notes take a date hint; others count on the entered date', async () => {
    const { note } = await addNote(
      ctx('alice'),
      { text: 'Background on the release train !context @2026-01-01 #p' },
      'cli',
      NOW,
    );
    expect(note).toMatchObject({ noteKind: 'context', applicableDate: TODAY });
  });

  test('an unknown project hint, or two projects, goes to the Inbox', async () => {
    const a = await addNote(ctx('alice'), { text: 'Something #nope' }, 'cli', NOW);
    expect(a.note.projectId).toBeNull();
    const [rev] = await listRevisions(ctx('alice'), a.note.id);
    expect(rev?.payload.hints).toMatchObject({ unresolvedProjects: ['nope'] });

    const b = await addNote(ctx('alice'), { text: 'Spans both #p #q' }, 'cli', NOW);
    expect(b.note.projectId).toBeNull();
  });

  test('an explicit projectId routes the note when there is no hint', async () => {
    const { note } = await addNote(
      ctx('alice'),
      { text: 'Quick add', projectId: s.p.P, visibility: 'project' },
      'web',
      NOW,
    );
    expect(note).toMatchObject({
      projectId: s.p.P,
      visibility: 'project',
      routingStatus: 'confirmed',
    });
  });

  test('a viewer cannot file into the project; the note goes to their Inbox', async () => {
    const { note, routed } = await addNote(ctx('carol'), { text: 'Viewer note #p' }, 'cli', NOW);
    expect(routed).toBe(false);
    expect(note.projectId).toBeNull();
  });

  test('restricted visibility is refused for now', async () => {
    await fails(addNote(ctx('alice'), { text: 'x', visibility: 'restricted' }, 'cli', NOW), 400);
  });
});

describe('editing and revisions', () => {
  test('an edit adds a content revision; the original text is kept', async () => {
    const { note } = await addNote(ctx('alice'), { text: 'Draft #p' }, 'cli', NOW);
    const edited = await editNote(ctx('alice'), note.id, { text: 'Final wording' });
    expect(edited).toMatchObject({ title: 'Final wording', revisionNo: 2, projectId: s.p.P });

    const revs = await listRevisions(ctx('alice'), note.id);
    expect(revs.map((r) => [r.revisionNo, r.kind, r.payload.text])).toEqual([
      [1, 'created', 'Draft #p'],
      [2, 'content', 'Final wording'],
    ]);
    expect(revs[0]?.contentHash).not.toBe(revs[1]?.contentHash);

    // The same text again changes nothing.
    const same = await editNote(ctx('alice'), note.id, { text: 'Final wording' });
    expect(same.revisionNo).toBe(2);
  });

  test('only the author edits a note', async () => {
    const { note } = await addNote(
      ctx('alice'),
      { text: 'Shared #p', visibility: 'project' },
      'cli',
      NOW,
    );
    await fails(editNote(ctx('dave'), note.id, { text: 'Hijack' }), 403, 'forbidden_role');
  });
});

describe('routing and the Inbox', () => {
  test('routing an Inbox note adds a metadata revision and empties the Inbox entry', async () => {
    const { note } = await addNote(ctx('alice'), { text: 'Sort me later' }, 'cli', NOW);
    let inbox = await listInbox(ctx('alice'), { limit: 200 });
    expect(inbox.items.map((i) => i.id)).toContain(note.id);

    const routed = await routeRecord(ctx('alice'), note.id, {
      projectId: s.p.P,
      date: '2026-11-02',
      kind: 'event',
      tags: ['Meeting'],
    });
    expect(routed).toMatchObject({
      projectId: s.p.P,
      applicableDate: '2026-11-02',
      routingStatus: 'confirmed',
      revisionNo: 2,
      tags: ['meeting'],
    });
    const revs = await listRevisions(ctx('alice'), note.id);
    expect(revs[1]).toMatchObject({
      kind: 'metadata',
      projectId: s.p.P,
      applicableDate: '2026-11-02',
    });
    expect(revs[1]?.contentHash).toBe(revs[0]?.contentHash as string);
    expect(revs[1]?.payload.text).toBe('Sort me later');

    inbox = await listInbox(ctx('alice'), { limit: 200 });
    expect(inbox.items.map((i) => i.id)).not.toContain(note.id);

    // Back to the Inbox.
    const back = await routeRecord(ctx('alice'), note.id, { projectId: null });
    expect(back).toMatchObject({ projectId: null, routingStatus: 'needs_review', revisionNo: 3 });
  });

  test('the Inbox pages newest first', async () => {
    const page1 = await listInbox(ctx('alice'), { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listInbox(ctx('alice'), { limit: 2, cursor: page1.nextCursor });
    const ids1 = page1.items.map((i) => i.id);
    expect(page2.items.every((i) => !ids1.includes(i.id) && i.id < (ids1[1] as string))).toBe(true);
  });

  test('a manager may route a member’s visible note; a contributor may not', async () => {
    const { note } = await addNote(
      ctx('alice'),
      { text: 'Team note #p', visibility: 'project' },
      'cli',
      NOW,
    );
    await fails(routeRecord(ctx('bob'), note.id, { date: '2026-11-01' }), 403, 'forbidden_role');
    const r = await routeRecord(ctx('dave'), note.id, { date: '2026-11-01' });
    expect(r.applicableDate).toBe('2026-11-01');
  });

  test('routing to a project you are not a contributor in is refused', async () => {
    // Alice owns workspace W, so she can see project Q, but she isn't a member of it.
    const { note } = await addNote(ctx('alice'), { text: 'Not for Q' }, 'cli', NOW);
    await fails(routeRecord(ctx('alice'), note.id, { projectId: s.p.Q }), 403, 'forbidden_role');
    // Bob can't see project R in another workspace at all.
    const bobs = await addNote(ctx('bob'), { text: 'Bob note' }, 'cli', NOW);
    await fails(routeRecord(ctx('bob'), bobs.note.id, { projectId: s.p.R }), 404);
  });

  test('an empty route request is a 400', async () => {
    const { note } = await addNote(ctx('alice'), { text: 'x' }, 'cli', NOW);
    await fails(routeRecord(ctx('alice'), note.id, {}), 400, 'bad_request');
  });
});

describe('visibility (row-level security underneath)', () => {
  test('project notes are visible to members; private ones only to the owner', async () => {
    const shared = await addNote(
      ctx('alice'),
      { text: 'Shared #p', visibility: 'project' },
      'cli',
      NOW,
    );
    const priv = await addNote(ctx('alice'), { text: 'Mine #p' }, 'cli', NOW);
    expect((await getRecord(ctx('carol'), shared.note.id)).isMine).toBe(false);
    await fails(getRecord(ctx('carol'), priv.note.id), 404, 'not_found');
    await fails(listRevisions(ctx('carol'), priv.note.id), 404);
    // Another workspace sees nothing.
    await fails(getRecord(ctx('mallory', 'W2'), shared.note.id), 404);
  });
});

describe('search', () => {
  test('full-text search, filters and paging', async () => {
    await addNote(ctx('alice'), { text: 'Kubernetes upgrade planning #p @2026-10-01' }, 'cli', NOW);
    await addNote(ctx('alice'), { text: 'Kubernetes upgrade done #p @2026-10-20' }, 'cli', NOW);
    await addNote(ctx('alice'), { text: 'Kubernetes notes in the Inbox' }, 'cli', NOW);

    const all = await search(ctx('alice'), { q: 'kubernetes' });
    expect(all.items).toHaveLength(3);
    expect(all.items.every((i) => i.score > 0)).toBe(true);

    const inP = await search(ctx('alice'), { q: 'kubernetes upgrade', projectId: s.p.P });
    expect(inP.items.map((i) => i.title).sort()).toEqual([
      'Kubernetes upgrade done',
      'Kubernetes upgrade planning',
    ]);

    // `to` is exclusive.
    const october = await search(ctx('alice'), {
      q: 'kubernetes',
      from: '2026-10-01',
      to: '2026-10-20',
    });
    expect(october.items.map((i) => i.title)).toEqual(['Kubernetes upgrade planning']);

    const p1 = await search(ctx('alice'), { q: 'kubernetes', limit: '2' });
    expect(p1.items).toHaveLength(2);
    const p2 = await search(ctx('alice'), { q: 'kubernetes', limit: '2', cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();

    // Others don't find Alice's private notes.
    expect((await search(ctx('carol'), { q: 'kubernetes' })).items).toHaveLength(0);
  });

  test('bad queries are a 400', async () => {
    await fails(search(ctx('alice'), { q: '' }), 400);
    await fails(search(ctx('alice'), { q: 'x', kinds: 'note,bogus' }), 400);
    await fails(search(ctx('alice'), { q: 'x', cursor: 'garbage' }), 400);
  });
});

describe('local mode', () => {
  test('init creates one owner and workspace, then is a no-op', async () => {
    const fresh = await createTestDb();
    try {
      await fails(localOwner(fresh.db), 409, 'not_initialized');
      const a = await initLocal(fresh.db, { name: 'Sam', timeZone: 'Asia/Seoul' });
      expect(a).toMatchObject({
        created: true,
        owner: { displayName: 'Sam', timeZone: 'Asia/Seoul' },
      });
      const b = await initLocal(fresh.db, { name: 'Other' });
      expect(b.created).toBe(false);
      expect(b.owner.userId).toBe(a.owner.userId);

      const owner = await localOwner(fresh.db);
      const c: Ctx = { db: fresh.db, actor: owner };
      const p = await createProject(c, { slug: 'home', name: 'Home' });
      expect(p.timeZone).toBe('Asia/Seoul');
      const { note } = await addNote(c, { text: 'Hello #home' }, 'cli', NOW);
      // 03:00 UTC is noon in Seoul: same day, Nov 8.
      expect(note).toMatchObject({ projectId: p.id, applicableDate: '2026-11-08' });

      await fails(initLocal(fresh.db, { timeZone: 'Nowhere/Land' }), 400);
    } finally {
      await fresh.close();
    }
  });
});
