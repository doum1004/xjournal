import { z } from 'zod';
import { memberRoles, noteKinds, recordKinds, reportKinds, visibilities } from './enums';

export const zId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'expected a ULID');
export const zIsoDate = z.iso.date();
export const zInstant = z.iso.datetime({ offset: false });
export const zRole = z.enum(memberRoles);
export const zVisibility = z.enum(visibilities);
export const zNoteKind = z.enum(noteKinds);
export const zRecordKind = z.enum(recordKinds);
export const zReportKind = z.enum(reportKinds);

/** The record contract every input tier submits (schema.md §1, api.md §2 RecordInput). */
export const zRecordInput = z.object({
  externalId: z.string().min(1),
  kind: zRecordKind,
  eventTime: zInstant,
  title: z.string().min(1).max(300),
  url: z.url().optional(),
  actor: z.string().min(1),
  summary: z.string().max(2000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  applicableDate: zIsoDate.optional(),
  projectHint: z.string().optional(),
});
export type RecordInput = z.infer<typeof zRecordInput>;

export const zSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'lower-case letters, digits, ".", "_" or "-"');

/** `POST /projects` (api.md §3.2). */
export const zProjectInput = z.object({
  slug: zSlug,
  name: z.string().trim().min(1).max(200),
  timeZone: z.string().optional(),
  defaultNoteVisibility: zVisibility.optional(),
});
export type ProjectInput = z.infer<typeof zProjectInput>;

export const noteChannels = ['cli', 'web', 'api', 'mcp', 'import'] as const;
export type NoteChannel = (typeof noteChannels)[number];

/** `POST /notes` (api.md §3.3). Agent routing (`routing`) arrives with the MCP tools in M3. */
export const zNoteInput = z.object({
  text: z.string().trim().min(1).max(20_000),
  projectId: zId.optional(),
  visibility: zVisibility.optional(),
});
export type NoteInput = z.infer<typeof zNoteInput>;

/** `PATCH /notes/{id}`. */
export const zNoteEdit = z.object({ text: z.string().trim().min(1).max(20_000) });

/**
 * `POST /records/{id}/route` (api.md §3.3). M1 routes to one project, or back to the Inbox
 * with `projectId: null`. Splitting a note across projects comes later.
 */
export const zRouteInput = z
  .object({
    projectId: zId.nullable().optional(),
    date: zIsoDate.optional(),
    kind: zNoteKind.optional(),
    visibility: zVisibility.optional(),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(64)).max(32).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to change');
export type RouteInput = z.infer<typeof zRouteInput>;

/** `GET /search` (api.md §3.3). `from` is inclusive and `to` exclusive (api.md §1). */
export const zSearchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  projectId: zId.optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  kinds: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(zRecordKind))
    .optional(),
  mode: z.enum(['text']).default('text'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type SearchQuery = z.infer<typeof zSearchQuery>;

export const zPageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/** `GET /projects/{p}/days` (api.md §3.4): `from` inclusive, `to` exclusive, at most ~2 years. */
export const zDayRange = z
  .object({ from: zIsoDate, to: zIsoDate })
  .refine((r) => r.from < r.to, 'from must be before to')
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= 800 * 86_400_000, 'range too long');
