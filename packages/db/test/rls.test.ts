import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@xjournal/core';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '../src';
import { createTestDb, testTarget } from '../src/testing';
import {
  affected,
  RLS_VIOLATION,
  type Seed,
  seed,
  seedConnector,
  seedInvite,
  seedPasskey,
  seedRecord,
  seedSession,
  unwrap,
  visible,
} from './fixtures';

// One test per policy (schema.md §9, plan.md M0). The last test checks that every policy in
// the database was exercised here, and that every table has RLS enabled and forced.

let h: DbHandle;
let s: Seed;
const covered = new Set<string>();
const cover = (...names: string[]) => {
  for (const n of names) covered.add(n);
};

beforeAll(async () => {
  h = await createTestDb();
  s = await seed(h);
});
afterAll(async () => {
  await h?.close();
});

describe(`RLS on ${testTarget()}`, () => {
  describe('users', () => {
    test('users_select: yourself and people you share a project with', async () => {
      cover('users_select');
      expect(await s.as('carol', (tx) => visible(tx, 'users'))).toBe(4); // alice, bob, carol, dave
      expect(await s.as('bob', (tx) => visible(tx, 'users'))).toBe(5); // + eve via Q
      expect(await s.as('mallory', (tx) => visible(tx, 'users'), 'W2')).toBe(1);
    });

    test('users_update: only your own row', async () => {
      cover('users_update');
      expect(
        await s.as('bob', (tx) =>
          affected(tx, `update users set display_name = 'Bob' where id = '${s.u.bob}'`),
        ),
      ).toBe(1);
      expect(
        await s.as('bob', (tx) =>
          affected(tx, `update users set display_name = 'X' where id = '${s.u.carol}'`),
        ),
      ).toBe(0);
    });
  });

  describe('workspaces', () => {
    test('workspaces_select: owner and members, current workspace only', async () => {
      cover('workspaces_select');
      expect(await s.as('carol', (tx) => visible(tx, 'workspaces'))).toBe(1);
      expect(await s.as('mallory', (tx) => visible(tx, 'workspaces'))).toBe(0); // wrong workspace context
      expect(await s.as('mallory', (tx) => visible(tx, 'workspaces'), 'W2')).toBe(1);
    });

    test('workspaces_insert: only as its owner, in the acting workspace', async () => {
      cover('workspaces_insert');
      const wid = newId();
      await withWorkspace(wid, 'bob', (tx) =>
        tx.execute(sql`insert into workspaces (id, domain, name, owner_user_id, time_zone)
                      values (${wid}, 'work', 'mine', ${s.u.bob}, 'UTC')`),
      );
      const other = newId();
      await expect(
        withWorkspace(other, 'bob', (tx) =>
          tx.execute(sql`insert into workspaces (id, domain, name, owner_user_id, time_zone)
                        values (${other}, 'work', 'theirs', ${s.u.carol}, 'UTC')`),
        ),
      ).rejects.toThrow(RLS_VIOLATION);
    });

    test('workspaces_update: owner only', async () => {
      cover('workspaces_update');
      expect(
        await s.as('alice', (tx) => affected(tx, `update workspaces set name = 'Work!'`)),
      ).toBe(1);
      expect(await s.as('dave', (tx) => affected(tx, `update workspaces set name = 'Nope'`))).toBe(
        0,
      );
    });
  });

  describe('projects', () => {
    test('projects_select: members, plus the workspace owner', async () => {
      cover('projects_select');
      expect(await s.as('carol', (tx) => visible(tx, 'projects'))).toBe(1);
      expect(await s.as('bob', (tx) => visible(tx, 'projects'))).toBe(2);
      expect(await s.as('alice', (tx) => visible(tx, 'projects'))).toBe(2); // owns W, so sees Q too
      expect(await s.as('mallory', (tx) => visible(tx, 'projects'))).toBe(0);
    });

    test('projects_insert: the workspace owner only', async () => {
      cover('projects_insert');
      await s.as('alice', (tx) =>
        tx.execute(
          sql`insert into projects (id, workspace_id, slug, name) values (${newId()}, ${s.ws.W}, 'new', 'New')`,
        ),
      );
      await expect(
        s.as('dave', (tx) =>
          tx.execute(
            sql`insert into projects (id, workspace_id, slug, name) values (${newId()}, ${s.ws.W}, 'nope', 'Nope')`,
          ),
        ),
      ).rejects.toThrow(RLS_VIOLATION);
    });

    test('projects_update: manager or owner of the project', async () => {
      cover('projects_update');
      expect(
        await s.as('dave', (tx) =>
          affected(tx, `update projects set name = 'P!' where id = '${s.p.P}'`),
        ),
      ).toBe(1);
      expect(
        await s.as('bob', (tx) =>
          affected(tx, `update projects set name = 'X' where id = '${s.p.P}'`),
        ),
      ).toBe(0);
    });
  });

  describe('project_members', () => {
    test('project_members_select: members of the project', async () => {
      cover('project_members_select');
      expect(await s.as('carol', (tx) => visible(tx, 'project_members'))).toBe(4);
      expect(await s.as('eve', (tx) => visible(tx, 'project_members'))).toBe(2);
    });

    test('project_members_insert: managers add below manager; owners anything', async () => {
      cover('project_members_insert');
      const add = (who: keyof Seed['u'], user: string, role: string) =>
        s.as(who, (tx) =>
          tx.execute(sql`insert into project_members (workspace_id, project_id, user_id, role)
                        values (${s.ws.W}, ${s.p.P}, ${user}, ${role}::member_role)`),
        );
      await add('dave', s.u.eve, 'commenter');
      await expect(add('dave', s.u.mallory, 'manager')).rejects.toThrow(RLS_VIOLATION);
      await expect(add('bob', s.u.mallory, 'viewer')).rejects.toThrow(RLS_VIOLATION);
      await add('alice', s.u.mallory, 'manager');
      await h.db.execute(
        sql`delete from project_members where project_id = ${s.p.P} and user_id in (${s.u.eve}, ${s.u.mallory})`,
      );
    });

    test('project_members_update: no self-promotion; managers only below manager', async () => {
      cover('project_members_update');
      const setRole = (who: keyof Seed['u'], target: keyof Seed['u'], role: string) =>
        s.as(who, (tx) =>
          affected(
            tx,
            `update project_members set role = '${role}' where project_id = '${s.p.P}' and user_id = '${s.u[target]}'`,
          ),
        );
      expect(await setRole('dave', 'carol', 'commenter')).toBe(1);
      await expect(setRole('carol', 'carol', 'owner')).rejects.toThrow(RLS_VIOLATION);
      await expect(setRole('dave', 'carol', 'owner')).rejects.toThrow(RLS_VIOLATION);
      expect(await setRole('dave', 'alice', 'viewer')).toBe(0); // can't touch an owner row
      // Leaving: a member may set their own left_at.
      expect(
        await s.as('carol', (tx) =>
          affected(
            tx,
            `update project_members set left_at = now() where project_id = '${s.p.P}' and user_id = '${s.u.carol}'`,
          ),
        ),
      ).toBe(1);
      await h.db.execute(
        sql`update project_members set left_at = null, role = 'viewer' where project_id = ${s.p.P} and user_id = ${s.u.carol}`,
      );
    });
  });

  describe('invites', () => {
    test('invites_select: managers and owners only', async () => {
      cover('invites_select');
      await seedInvite(s);
      expect(await s.as('dave', (tx) => visible(tx, 'invites'))).toBeGreaterThan(0);
      expect(await s.as('bob', (tx) => visible(tx, 'invites'))).toBe(0);
    });

    test('invites_insert: managers invite below manager; owners invite managers', async () => {
      cover('invites_insert');
      const invite = (who: keyof Seed['u'], role: string) =>
        s.as(who, (tx) =>
          tx.execute(sql`insert into invites (id, workspace_id, project_id, kind, role, display_name, token_hash,
                                               code_hash, created_by, expires_at)
                        values (${newId()}, ${s.ws.W}, ${s.p.P}, 'join', ${role}::member_role, 'G', ${newId()},
                                'c', ${s.u[who]}, now() + interval '1 day')`),
        );
      await invite('dave', 'contributor');
      await expect(invite('dave', 'manager')).rejects.toThrow(RLS_VIOLATION);
      await expect(invite('bob', 'viewer')).rejects.toThrow(RLS_VIOLATION);
      await invite('alice', 'manager');
    });

    test('invites_update: managers can revoke', async () => {
      cover('invites_update');
      const iid = await seedInvite(s);
      expect(
        await s.as('dave', (tx) =>
          affected(tx, `update invites set revoked_at = now() where id = '${iid}'`),
        ),
      ).toBe(1);
      expect(
        await s.as('bob', (tx) =>
          affected(tx, `update invites set revoked_at = now() where id = '${iid}'`),
        ),
      ).toBe(0);
    });
  });

  describe('passkeys and sessions', () => {
    test('passkeys_select: own devices, plus managers of a shared project', async () => {
      cover('passkeys_select');
      const pk = await seedPasskey(s, 'carol');
      expect(await s.as('carol', (tx) => visible(tx, 'passkeys', `id = '${pk}'`))).toBe(1);
      expect(await s.as('dave', (tx) => visible(tx, 'passkeys', `id = '${pk}'`))).toBe(1);
      expect(await s.as('bob', (tx) => visible(tx, 'passkeys', `id = '${pk}'`))).toBe(0);
      expect(await s.as('eve', (tx) => visible(tx, 'passkeys', `id = '${pk}'`))).toBe(0);
    });

    test('passkeys_update: device approval by a manager of a shared project', async () => {
      cover('passkeys_update');
      const pk = await seedPasskey(s, 'carol');
      const approve = (who: keyof Seed['u']) =>
        s.as(who, (tx) =>
          affected(
            tx,
            `update passkeys set status = 'approved', approved_by = '${s.u[who]}' where id = '${pk}'`,
          ),
        );
      expect(await approve('bob')).toBe(0);
      expect(await approve('eve')).toBe(0);
      expect(await approve('dave')).toBe(1);
    });

    test('sessions_owner: only your own sessions', async () => {
      cover('sessions_owner');
      const sid = await seedSession(s, 'bob');
      expect(await s.as('bob', (tx) => visible(tx, 'sessions', `id = '${sid}'`))).toBe(1);
      expect(await s.as('alice', (tx) => visible(tx, 'sessions', `id = '${sid}'`))).toBe(0);
      expect(
        await s.as('alice', (tx) => affected(tx, `delete from sessions where id = '${sid}'`)),
      ).toBe(0);
      expect(
        await s.as('bob', (tx) => affected(tx, `delete from sessions where id = '${sid}'`)),
      ).toBe(1);
    });
  });

  describe('tokens, identities, connectors', () => {
    test('access_tokens_owner: own tokens in the acting workspace', async () => {
      cover('access_tokens_owner');
      const mk = (who: keyof Seed['u'], owner: keyof Seed['u']) =>
        s.as(who, (tx) =>
          tx.execute(sql`insert into access_tokens (id, user_id, workspace_id, kind, token_hash, scopes)
                        values (${newId()}, ${s.u[owner]}, ${s.ws.W}, 'pat', ${newId()}, '{read}')`),
        );
      await mk('bob', 'bob');
      await expect(mk('bob', 'carol')).rejects.toThrow(RLS_VIOLATION);
      expect(await s.as('bob', (tx) => visible(tx, 'access_tokens'))).toBe(1);
      expect(await s.as('alice', (tx) => visible(tx, 'access_tokens'))).toBe(0);
    });

    test('identities_owner: own identities only', async () => {
      cover('identities_owner');
      await s.as('bob', (tx) =>
        tx.execute(sql`insert into identities (id, workspace_id, user_id, source, account_key)
                      values (${newId()}, ${s.ws.W}, ${s.u.bob}, 'github:github.com', 'bob')`),
      );
      expect(await s.as('bob', (tx) => visible(tx, 'identities'))).toBe(1);
      expect(await s.as('alice', (tx) => visible(tx, 'identities'))).toBe(0);
    });

    test('connector_accounts_owner: never shared, even with the workspace owner', async () => {
      cover('connector_accounts_owner');
      const cid = await seedConnector(s, 'bob');
      expect(await s.as('bob', (tx) => visible(tx, 'connector_accounts', `id = '${cid}'`))).toBe(1);
      expect(await s.as('alice', (tx) => visible(tx, 'connector_accounts', `id = '${cid}'`))).toBe(
        0,
      );
    });

    test('sync_states_owner: follows the connector owner', async () => {
      cover('sync_states_owner');
      const cid = await seedConnector(s, 'bob');
      const write = (who: keyof Seed['u']) =>
        s.as(who, (tx) =>
          tx.execute(sql`insert into sync_states (connector_account_id, stream, workspace_id)
                        values (${cid}, ${`events-${newId()}`}, ${s.ws.W})`),
        );
      await write('bob');
      await expect(write('alice')).rejects.toThrow(RLS_VIOLATION);
      expect(await s.as('alice', (tx) => visible(tx, 'sync_states'))).toBe(0);
    });

    test('project_sources_select / _write: contributors attach their own connectors; members read', async () => {
      cover('project_sources_select', 'project_sources_write');
      const bobs = await seedConnector(s, 'bob');
      const carols = await seedConnector(s, 'carol');
      const attach = (who: keyof Seed['u'], cid: string) =>
        s.as(who, (tx) =>
          tx.execute(sql`insert into project_sources (project_id, connector_account_id, workspace_id, added_by)
                        values (${s.p.P}, ${cid}, ${s.ws.W}, ${s.u[who]})`),
        );
      await attach('bob', bobs);
      await expect(attach('carol', carols)).rejects.toThrow(RLS_VIOLATION); // viewer
      await expect(attach('dave', bobs)).rejects.toThrow(RLS_VIOLATION); // not his connector
      expect(await s.as('carol', (tx) => visible(tx, 'project_sources'))).toBe(1);
      expect(await s.as('eve', (tx) => visible(tx, 'project_sources'))).toBe(0);
    });
  });

  describe('project_rules', () => {
    const insertRule = (who: keyof Seed['u'], ruleId = newId()) =>
      s.as(who, (tx) =>
        tx.execute(sql`insert into project_rules (id, workspace_id, project_id, priority, match, version, created_by)
                      values (${ruleId}, ${s.ws.W}, ${s.p.P}, 1, '{}'::jsonb, 1, ${s.u[who]})`),
      );

    test('project_rules_insert: managers and the workspace owner', async () => {
      cover('project_rules_insert');
      await insertRule('dave');
      await expect(insertRule('bob')).rejects.toThrow(RLS_VIOLATION);
    });

    test('project_rules_select: members of the project', async () => {
      cover('project_rules_select');
      expect(await s.as('carol', (tx) => visible(tx, 'project_rules'))).toBeGreaterThan(0);
      expect(await s.as('eve', (tx) => visible(tx, 'project_rules'))).toBe(0);
    });

    test('project_rules_update: managers only', async () => {
      cover('project_rules_update');
      expect(
        await s.as('dave', (tx) => affected(tx, `update project_rules set active = false`)),
      ).toBeGreaterThan(0);
      expect(
        await s.as('bob', (tx) => affected(tx, `update project_rules set active = true`)),
      ).toBe(0);
    });
  });

  describe('records', () => {
    test('records_select: owner; project visibility for members; restricted for the audience; Inbox for the owner', async () => {
      cover('records_select');
      const shared = await seedRecord(s, { owner: 'bob', project: 'P', visibility: 'project' });
      const priv = await seedRecord(s, { owner: 'bob', project: 'P', visibility: 'private' });
      const restricted = await seedRecord(s, {
        owner: 'bob',
        project: 'P',
        visibility: 'restricted',
        audience: ['carol'],
      });
      const inbox = await seedRecord(s, { owner: 'bob', project: null, visibility: 'project' });
      const sees = (who: keyof Seed['u'], rid: string) =>
        s.as(who, (tx) => visible(tx, 'records', `id = '${rid}'`));

      expect(await sees('carol', shared.recordId)).toBe(1);
      expect(await sees('eve', shared.recordId)).toBe(0); // not a member of P
      expect(await sees('carol', priv.recordId)).toBe(0);
      expect(await sees('alice', priv.recordId)).toBe(0); // owners don't see private items either
      expect(await sees('carol', restricted.recordId)).toBe(1);
      expect(await sees('dave', restricted.recordId)).toBe(0);
      expect(await sees('alice', inbox.recordId)).toBe(0);
      for (const r of [shared, priv, restricted, inbox])
        expect(await sees('bob', r.recordId)).toBe(1);
    });

    test('records_insert: as yourself, into the Inbox or a project where you contribute', async () => {
      cover('records_insert');
      const insert = (who: keyof Seed['u'], owner: keyof Seed['u'], project: string | null) => {
        const rid = newId();
        return s.as(who, (tx) =>
          tx.execute(sql`insert into records (id, workspace_id, source, external_id, kind, tier, owner_user_id,
                           is_mine, event_time, captured_at, applicable_date, project_id, routing_status,
                           routed_by, visibility, current_revision_id, title)
                         values (${rid}, ${s.ws.W}, 'note', ${rid}, 'note', 'manual', ${s.u[owner]}, true, now(),
                           now(), '2026-11-08', ${project}, 'confirmed', 'user', 'private', ${newId()}, 't')`),
        );
      };
      await insert('bob', 'bob', s.p.P);
      await insert('carol', 'carol', null); // a viewer may still use their own Inbox
      await expect(insert('carol', 'carol', s.p.P)).rejects.toThrow(RLS_VIOLATION);
      await expect(insert('bob', 'carol', s.p.P)).rejects.toThrow(RLS_VIOLATION);
    });

    test('records_update: the owner re-routes into projects they contribute to; managers moderate', async () => {
      cover('records_update');
      const r = await seedRecord(s, { owner: 'bob', project: 'P', visibility: 'project' });
      expect(
        await s.as('bob', (tx) =>
          affected(tx, `update records set project_id = '${s.p.Q}' where id = '${r.recordId}'`),
        ),
      ).toBe(1);
      await expect(
        s.as('bob', (tx) =>
          affected(tx, `update records set project_id = '${s.p.R}' where id = '${r.recordId}'`),
        ),
      ).rejects.toThrow(RLS_VIOLATION);
      await h.db.execute(sql`update records set project_id = ${s.p.P} where id = ${r.recordId}`);
      expect(
        await s.as('dave', (tx) =>
          affected(tx, `update records set hidden_at = now() where id = '${r.recordId}'`),
        ),
      ).toBe(1);
      expect(
        await s.as('carol', (tx) =>
          affected(tx, `update records set hidden_at = null where id = '${r.recordId}'`),
        ),
      ).toBe(0);
    });

    test('records: no DELETE for the app role', async () => {
      const r = await seedRecord(s, { owner: 'bob', project: 'P', visibility: 'project' });
      await expect(
        s.as('bob', (tx) => affected(tx, `delete from records where id = '${r.recordId}'`)),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('record_revisions', () => {
    test('record_revisions_select: visible with the record', async () => {
      cover('record_revisions_select');
      const r = await seedRecord(s, { owner: 'bob', project: 'P', visibility: 'private' });
      expect(
        await s.as('bob', (tx) => visible(tx, 'record_revisions', `id = '${r.revisionId}'`)),
      ).toBe(1);
      expect(
        await s.as('carol', (tx) => visible(tx, 'record_revisions', `id = '${r.revisionId}'`)),
      ).toBe(0);
    });

    test('record_revisions_insert: by whoever may edit the record; append-only', async () => {
      cover('record_revisions_insert');
      const r = await seedRecord(s, { owner: 'bob', project: 'P', visibility: 'project' });
      const addRevision = (who: keyof Seed['u'], no: number) =>
        s.as(who, (tx) =>
          tx.execute(sql`insert into record_revisions (id, record_id, workspace_id, revision_no, kind, content_hash,
                           title, applicable_date, visibility)
                         values (${newId()}, ${r.recordId}, ${s.ws.W}, ${no}, 'content', 'y', 't2', '2026-11-08', 'project')`),
        );
      await addRevision('bob', 2);
      await expect(addRevision('carol', 3)).rejects.toThrow(RLS_VIOLATION);
      await expect(
        s.as('bob', (tx) =>
          affected(tx, `update record_revisions set title = 'x' where record_id = '${r.recordId}'`),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        s.as('bob', (tx) =>
          affected(tx, `delete from record_revisions where record_id = '${r.recordId}'`),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('record children', () => {
    for (const table of ['record_audiences', 'record_tags', 'record_people'] as const) {
      test(`${table}_select / _insert / _update / _delete: follow the parent record`, async () => {
        cover(`${table}_select`, `${table}_insert`, `${table}_update`, `${table}_delete`);
        const r = await seedRecord(s, { owner: 'bob', project: 'P', visibility: 'project' });
        const values =
          table === 'record_audiences'
            ? `('${r.recordId}', '${s.u.carol}', '${s.ws.W}')`
            : table === 'record_tags'
              ? `('${r.recordId}', 'sdk', '${s.ws.W}')`
              : `('${r.recordId}', '${s.ws.W}', null, 'Carol')`;
        const cols =
          table === 'record_audiences'
            ? '(record_id, user_id, workspace_id)'
            : table === 'record_tags'
              ? '(record_id, tag, workspace_id)'
              : '(record_id, workspace_id, identity_id, person_label)';
        const insert = (who: keyof Seed['u']) =>
          s.as(who, (tx) => tx.execute(sql.raw(`insert into ${table} ${cols} values ${values}`)));

        await expect(insert('carol')).rejects.toThrow(RLS_VIOLATION);
        await insert('bob');
        expect(await s.as('carol', (tx) => visible(tx, table, `record_id = '${r.recordId}'`))).toBe(
          1,
        );
        expect(await s.as('eve', (tx) => visible(tx, table, `record_id = '${r.recordId}'`))).toBe(
          0,
        );
        expect(
          await s.as('carol', (tx) =>
            affected(
              tx,
              `update ${table} set workspace_id = workspace_id where record_id = '${r.recordId}'`,
            ),
          ),
        ).toBe(0);
        expect(
          await s.as('bob', (tx) =>
            affected(
              tx,
              `update ${table} set workspace_id = workspace_id where record_id = '${r.recordId}'`,
            ),
          ),
        ).toBe(1);
        expect(
          await s.as('carol', (tx) =>
            affected(tx, `delete from ${table} where record_id = '${r.recordId}'`),
          ),
        ).toBe(0);
        expect(
          await s.as('bob', (tx) =>
            affected(tx, `delete from ${table} where record_id = '${r.recordId}'`),
          ),
        ).toBe(1);
      });
    }
  });

  describe('hub_auth', () => {
    const authTables = [
      'users',
      'sessions',
      'passkeys',
      'accounts',
      'verifications',
      'jwks',
      'oauth_clients',
      'oauth_resources',
      'oauth_client_resources',
      'oauth_refresh_tokens',
      'oauth_access_tokens',
      'oauth_consents',
      'oauth_client_assertions',
      'invites',
      'project_members',
      'projects',
    ];

    test('*_auth: the auth role reads sign-in tables without a user context', async () => {
      cover(...authTables.map((t) => `${t}_auth`));
      const n = await s.asAuth(async (tx) => {
        const counts: number[] = [];
        for (const t of authTables) counts.push(await visible(tx, t));
        return counts;
      });
      expect(n[0]).toBe(6); // all users
      expect(n[authTables.indexOf('projects')]).toBeGreaterThanOrEqual(3);
    });

    test('hub_auth cannot read evidence, connectors or tokens', async () => {
      for (const t of [
        'records',
        'record_revisions',
        'connector_accounts',
        'access_tokens',
        'workspaces',
      ]) {
        await expect(s.asAuth((tx) => visible(tx, t))).rejects.toThrow(/permission denied/);
      }
    });

    test('hub_app cannot read library-owned auth tables', async () => {
      for (const t of [
        'accounts',
        'verifications',
        'jwks',
        'oauth_clients',
        'oauth_access_tokens',
      ]) {
        await expect(s.as('alice', (tx) => visible(tx, t))).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe('reports and guidance', () => {
    const ins = (who: keyof Seed['u'], stmt: string) => s.as(who, (tx) => affected(tx, stmt));
    let report = '';
    let version = '';

    test('reports_insert, report_audience_insert, reports_select, report_audience_select', async () => {
      cover('reports_insert', 'report_audience_insert', 'reports_select', 'report_audience_select');
      report = newId();
      const mk = (id: string) =>
        `insert into reports (id, workspace_id, project_id, kind, period_start, period_end_excl, audience_key)
         values ('${id}', '${s.ws.W}', '${s.p.P}', 'daily', '2026-11-08', '2026-11-09', 'me:${s.u.bob}')`;
      // bob (contributor of P) creates the report and puts himself in its audience, in one go.
      await s.as('bob', async (tx) => {
        await affected(tx, mk(report));
        await affected(
          tx,
          `insert into report_audience (report_id, user_id, workspace_id) values ('${report}', '${s.u.bob}', '${s.ws.W}')`,
        );
      });
      await expect(ins('carol', mk(newId()))).rejects.toThrow(RLS_VIOLATION); // viewer
      await expect(
        ins(
          'carol',
          `insert into report_audience (report_id, user_id, workspace_id) values ('${report}', '${s.u.carol}', '${s.ws.W}')`,
        ),
      ).rejects.toThrow(RLS_VIOLATION);
      const sees = (who: keyof Seed['u'], t: string) =>
        s.as(who, (tx) =>
          visible(
            tx,
            t,
            `report_id = '${report}'`.replace('report_id', t === 'reports' ? 'id' : 'report_id'),
          ),
        );
      expect(await sees('bob', 'reports')).toBe(1);
      expect(await sees('dave', 'reports')).toBe(0); // a manager, but not in the audience
      expect(await sees('bob', 'report_audience')).toBe(1);
      expect(await sees('dave', 'report_audience')).toBe(0);
    });

    test('report_versions_insert/select, reports_update', async () => {
      cover('report_versions_insert', 'report_versions_select', 'reports_update');
      version = newId();
      const v = (id: string, actor: string) =>
        `insert into report_versions (id, report_id, workspace_id, version_no, body_md, path, template_version,
           actor_user_id, input_hash, guidance_hash, change_reason, validation)
         values ('${id}', '${report}', '${s.ws.W}', ${id === version ? 1 : 2}, '- x', 'agent', 'daily@1',
           '${actor}', 'i', 'g', 'initial', '{}')`;
      expect(await ins('bob', v(version, s.u.bob))).toBe(1);
      await expect(ins('dave', v(newId(), s.u.dave))).rejects.toThrow(RLS_VIOLATION);
      await expect(ins('bob', v(newId(), s.u.dave))).rejects.toThrow(RLS_VIOLATION); // as someone else
      expect(
        await s.as('bob', (tx) => visible(tx, 'report_versions', `report_id = '${report}'`)),
      ).toBe(1);
      expect(
        await s.as('dave', (tx) => visible(tx, 'report_versions', `report_id = '${report}'`)),
      ).toBe(0);
      const upd = `update reports set current_version_id = '${version}' where id = '${report}'`;
      expect(await ins('bob', upd)).toBe(1);
      expect(await ins('dave', upd)).toBe(0);
    });

    test('report_inputs, evidence_refs, report_stats: read with the report, written by its writers', async () => {
      const rows: [string, string][] = [
        [
          'report_inputs',
          `(report_version_id, workspace_id, input_type, input_id, input_hash) values ('${version}', '${s.ws.W}', 'bundle', 'b1', 'h')`,
        ],
        [
          'evidence_refs',
          `(report_version_id, workspace_id, anchor, ref_type, ref_id) values ('${version}', '${s.ws.W}', 'a1', 'record_revision', 'r1')`,
        ],
        [
          'report_stats',
          `(id, report_version_id, workspace_id, metric, query, value) values ('${newId()}', '${version}', '${s.ws.W}', 'm', '{}', '1')`,
        ],
      ];
      for (const [t, values] of rows) {
        cover(`${t}_insert`, `${t}_select`);
        expect(await ins('bob', `insert into ${t} ${values}`)).toBe(1);
        await expect(
          ins('dave', `insert into ${t} ${values.replace("'b1'", "'b2'").replace("'a1'", "'a2'")}`),
        ).rejects.toThrow(RLS_VIOLATION);
        expect(await s.as('bob', (tx) => visible(tx, t, `report_version_id = '${version}'`))).toBe(
          1,
        );
        expect(await s.as('dave', (tx) => visible(tx, t, `report_version_id = '${version}'`))).toBe(
          0,
        );
      }
    });

    test('guidance_insert, guidance_select, guidance_update, guidance_versions_*', async () => {
      cover(
        'guidance_insert',
        'guidance_select',
        'guidance_update',
        'guidance_versions_insert',
        'guidance_versions_select',
      );
      const g = (id: string, author: string, scope: string, extra = '') =>
        `insert into guidance (id, workspace_id, scope, project_id, report_id, author_user_id, visibility)
         values ('${id}', '${s.ws.W}', '${scope}', ${scope === 'workspace' ? 'null' : `'${s.p.P}'`},
           ${scope === 'report' ? `'${report}'` : 'null'}, '${author}', ${extra || "'project'"})`;
      const ws = newId();
      const proj = newId();
      const priv = newId();
      expect(await ins('alice', g(ws, s.u.alice, 'workspace'))).toBe(1);
      await expect(ins('bob', g(newId(), s.u.bob, 'workspace'))).rejects.toThrow(RLS_VIOLATION);
      expect(await ins('dave', g(proj, s.u.dave, 'project'))).toBe(1);
      await expect(ins('bob', g(newId(), s.u.bob, 'project'))).rejects.toThrow(RLS_VIOLATION);
      expect(await ins('bob', g(newId(), s.u.bob, 'report'))).toBe(1); // he writes that report
      expect(await ins('dave', g(priv, s.u.dave, 'project', "'private'"))).toBe(1);

      const sees = (who: keyof Seed['u'], id: string) =>
        s.as(who, (tx) => visible(tx, 'guidance', `id = '${id}'`));
      expect(await sees('carol', proj)).toBe(1); // a member of P
      expect(await sees('eve', proj)).toBe(0);
      expect(await sees('carol', priv)).toBe(0);
      expect(await sees('dave', priv)).toBe(1);
      expect(await sees('eve', ws)).toBe(1); // workspace scope: any member of the workspace's projects

      expect(
        await ins('dave', `update guidance set archived_at = now() where id = '${priv}'`),
      ).toBe(1);
      expect(
        await ins('alice', `update guidance set archived_at = now() where id = '${proj}'`),
      ).toBe(0);

      const gv = (gid: string, by: string) =>
        `insert into guidance_versions (id, guidance_id, workspace_id, version_no, text, content_hash, created_by)
         values ('${newId()}', '${gid}', '${s.ws.W}', 1, 'Be concise', 'h', '${by}')`;
      expect(await ins('dave', gv(proj, s.u.dave))).toBe(1);
      await expect(ins('bob', gv(proj, s.u.bob))).rejects.toThrow(RLS_VIOLATION);
      expect(
        await s.as('carol', (tx) => visible(tx, 'guidance_versions', `guidance_id = '${proj}'`)),
      ).toBe(1);
      expect(
        await s.as('eve', (tx) => visible(tx, 'guidance_versions', `guidance_id = '${proj}'`)),
      ).toBe(0);
    });
  });

  describe('exports', () => {
    test('exports_insert, exports_select: your own, for versions you can read', async () => {
      cover('exports_insert', 'exports_select');
      const [v] = (
        await s.db.execute<{ id: string; created_by: string }>(
          sql`select id from report_versions limit 1`,
        )
      ).rows;
      const row = (who: keyof Seed['u']) =>
        `insert into exports (id, workspace_id, report_version_id, destination, target, created_by)
         values ('${newId()}', '${s.ws.W}', '${v?.id}', 'confluence-worklog', '2026-11-08', '${s.u[who]}')`;
      expect(await s.as('bob', (tx) => affected(tx, row('bob')))).toBe(1);
      await expect(s.as('dave', (tx) => affected(tx, row('dave')))).rejects.toThrow(RLS_VIOLATION);
      await expect(s.as('dave', (tx) => affected(tx, row('bob')))).rejects.toThrow(RLS_VIOLATION);
      expect(await s.as('bob', (tx) => visible(tx, 'exports'))).toBe(1);
      expect(await s.as('dave', (tx) => visible(tx, 'exports'))).toBe(0);
    });
  });

  describe('career_entries', () => {
    test('career_entries_*: your own, in your projects, from versions you can read', async () => {
      cover(
        'career_entries_select',
        'career_entries_insert',
        'career_entries_update',
        'career_entries_delete',
      );
      const [v] = (await s.db.execute<{ id: string }>(sql`select id from report_versions limit 1`))
        .rows;
      const row = (id: string, who: keyof Seed['u'], project: keyof Seed['p'], src = 'null') =>
        `insert into career_entries (id, workspace_id, project_id, user_id, period_start, body_md, source_version_id)
         values ('${id}', '${s.ws.W}', '${s.p[project]}', '${s.u[who]}', '2026-10-01', '- Shipped it', ${src})`;
      const mine = newId();
      expect(await s.as('bob', (tx) => affected(tx, row(mine, 'bob', 'P', `'${v?.id}'`)))).toBe(1);
      // Not for someone else, not outside your projects, not from a version you can't read.
      await expect(s.as('dave', (tx) => affected(tx, row(newId(), 'bob', 'P')))).rejects.toThrow(
        RLS_VIOLATION,
      );
      await expect(s.as('carol', (tx) => affected(tx, row(newId(), 'carol', 'Q')))).rejects.toThrow(
        RLS_VIOLATION,
      );
      await expect(
        s.as('dave', (tx) => affected(tx, row(newId(), 'dave', 'P', `'${v?.id}'`))),
      ).rejects.toThrow(RLS_VIOLATION);

      expect(await s.as('bob', (tx) => visible(tx, 'career_entries'))).toBe(1);
      expect(await s.as('dave', (tx) => visible(tx, 'career_entries'))).toBe(0);
      const upd = `update career_entries set status = 'approved' where id = '${mine}'`;
      expect(await s.as('dave', (tx) => affected(tx, upd))).toBe(0);
      expect(await s.as('bob', (tx) => affected(tx, upd))).toBe(1);
      const del = `delete from career_entries where id = '${mine}'`;
      expect(await s.as('dave', (tx) => affected(tx, del))).toBe(0);
      expect(await s.as('bob', (tx) => affected(tx, del))).toBe(1);
    });
  });

  describe('daily bundles', () => {
    /** A bundle for a project and date holding the given revisions (as superuser). */
    async function seedBundle(
      project: keyof Seed['p'],
      revisionIds: string[],
      date = '2026-11-09',
    ) {
      const id = newId();
      await s.db.execute(sql`insert into daily_bundles (id, workspace_id, project_id, date, content_hash, coverage)
        values (${id}, ${s.ws.W}, ${s.p[project]}, ${date}, 'h', '{}')`);
      for (const rid of revisionIds) {
        await s.db.execute(sql`insert into bundle_items (bundle_id, record_revision_id, workspace_id)
          values (${id}, ${rid}, ${s.ws.W})`);
      }
      return id;
    }

    test('daily_bundles_select: members of the project; no writes for hub_app', async () => {
      cover('daily_bundles_select');
      const b = await seedBundle('Q', []);
      const sees = (who: keyof Seed['u']) =>
        s.as(who, (tx) => visible(tx, 'daily_bundles', `id = '${b}'`));
      expect(await sees('eve')).toBe(1);
      expect(await sees('bob')).toBe(1);
      expect(await sees('carol')).toBe(0); // not in Q
      await expect(
        s.as('eve', (tx) =>
          tx.execute(sql`update daily_bundles set content_hash = 'x' where id = ${b}`),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    test('bundle_items_select: only revisions of records the caller can see', async () => {
      cover('bundle_items_select');
      const shared = await seedRecord(s, { owner: 'bob', project: 'Q', visibility: 'project' });
      const priv = await seedRecord(s, { owner: 'bob', project: 'Q', visibility: 'private' });
      const b = await seedBundle('Q', [shared.revisionId, priv.revisionId], '2026-11-08');
      const count = (who: keyof Seed['u']) =>
        s.as(who, (tx) => visible(tx, 'bundle_items', `bundle_id = '${b}'`));
      expect(await count('bob')).toBe(2);
      expect(await count('eve')).toBe(1); // bob's private record stays hidden
      expect(await count('carol')).toBe(0);
    });

    test('changing a record marks the bundles of its old and new day dirty', async () => {
      const r = await seedRecord(s, { owner: 'bob', project: 'P', visibility: 'project' });
      const onP = await seedBundle('P', []);
      const dirty = async (id: string) => {
        const x = await s.db.execute<{ d: string | null }>(
          sql`select dirty_since as d from daily_bundles where id = ${id}`,
        );
        return x.rows[0]?.d != null;
      };
      // seedRecord dates are 2026-11-08; move it to the bundle's day as the owner, under RLS.
      await s.as('bob', (tx) =>
        tx.execute(sql`update records set applicable_date = '2026-11-09' where id = ${r.recordId}`),
      );
      expect(await dirty(onP)).toBe(true);
      await s.db.execute(sql`update daily_bundles set dirty_since = null where id = ${onP}`);
      await s.as('bob', (tx) =>
        tx.execute(sql`update records set applicable_date = '2026-11-10' where id = ${r.recordId}`),
      );
      expect(await dirty(onP)).toBe(true); // the old day lost a record
    });
  });

  describe('work items', () => {
    /** A work item in a project linking the given records (as superuser). */
    async function seedItem(project: keyof Seed['p'], recordIds: string[]) {
      const id = newId();
      await s.db.execute(sql`insert into work_items (id, workspace_id, project_id, key, title)
        values (${id}, ${s.ws.W}, ${s.p[project]}, ${id}, 'PIX-1 Fix')`);
      for (const rid of recordIds) {
        await s.db.execute(sql`insert into work_item_links (work_item_id, record_id, workspace_id, origin)
          values (${id}, ${rid}, ${s.ws.W}, 'rule')`);
      }
      return id;
    }

    test('work_item_links_select: only links of records the caller can see', async () => {
      cover('work_item_links_select');
      const shared = await seedRecord(s, { owner: 'bob', project: 'Q', visibility: 'project' });
      const priv = await seedRecord(s, { owner: 'bob', project: 'Q', visibility: 'private' });
      const w = await seedItem('Q', [shared.recordId, priv.recordId]);
      const count = (who: keyof Seed['u']) =>
        s.as(who, (tx) => visible(tx, 'work_item_links', `work_item_id = '${w}'`));
      expect(await count('bob')).toBe(2);
      expect(await count('eve')).toBe(1); // bob's private record stays hidden
      expect(await count('carol')).toBe(0); // not in Q
      await expect(
        s.as('bob', (tx) => tx.execute(sql`delete from work_item_links where work_item_id = ${w}`)),
      ).rejects.toThrow(/permission denied/);
    });

    test('work_items_select: members who can see one of its links; no writes', async () => {
      cover('work_items_select');
      const priv = await seedRecord(s, { owner: 'bob', project: 'Q', visibility: 'private' });
      const w = await seedItem('Q', [priv.recordId]);
      const empty = await seedItem('Q', []);
      const sees = (who: keyof Seed['u'], id: string) =>
        s.as(who, (tx) => visible(tx, 'work_items', `id = '${id}'`));
      expect(await sees('bob', w)).toBe(1);
      expect(await sees('eve', w)).toBe(0); // a member, but every link is hidden from her
      expect(await sees('carol', w)).toBe(0);
      expect(await sees('bob', empty)).toBe(0);
      await expect(
        s.as('eve', (tx) => tx.execute(sql`update work_items set title = 'x' where id = ${w}`)),
      ).rejects.toThrow(/permission denied/);
    });

    test('work_item_ai_checks: system only', async () => {
      const r = await seedRecord(s, { owner: 'bob', project: 'Q', visibility: 'project' });
      await s.db.execute(sql`insert into work_item_ai_checks (record_id, workspace_id, revision_id)
        values (${r.recordId}, ${s.ws.W}, ${r.revisionId})`);
      await expect(
        s.as('bob', (tx) => tx.execute(sql`select * from work_item_ai_checks`)),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('workspace isolation', () => {
    test('a user in another workspace context sees nothing of W', async () => {
      await seedRecord(s, {
        owner: 'mallory',
        project: 'R',
        visibility: 'project',
        workspace: 'W2',
      });
      for (const t of ['projects', 'project_members', 'records', 'record_revisions', 'invites']) {
        expect(await s.as('alice', (tx) => visible(tx, t, `workspace_id = '${s.ws.W2}'`))).toBe(0);
      }
      expect(await s.as('mallory', (tx) => visible(tx, 'records'), 'W2')).toBe(1);
    });
  });

  test('every table has RLS enabled and forced, and every policy is tested', async () => {
    const tables = await h.db.execute<{ relname: string; on: boolean; forced: boolean }>(sql`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    const unprotected = tables.rows.filter((t) => !t.on || !t.forced).map((t) => t.relname);
    expect(unprotected).toEqual([]);

    const policies = await h.db.execute<{ policyname: string }>(
      sql`select policyname from pg_policies where schemaname = 'public'`,
    );
    const untested = policies.rows.map((p) => p.policyname).filter((p) => !covered.has(p));
    expect(untested).toEqual([]);
  });
});

/** Act as `who` in a workspace that doesn't exist yet (for workspace creation). */
function withWorkspace<T>(
  workspaceId: string,
  who: keyof Seed['u'],
  fn: Parameters<Seed['as']>[1],
): Promise<T> {
  return h.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local role hub_app`);
      await tx.execute(
        sql`select set_config('app.user_id', ${s.u[who]}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
      );
      return fn(tx) as Promise<T>;
    })
    .catch(unwrap);
}
