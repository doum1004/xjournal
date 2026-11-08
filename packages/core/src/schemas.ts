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
