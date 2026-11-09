import {
  changeReasons,
  deviceStatuses,
  genPaths,
  guidanceScopes,
  inputTiers,
  inviteKinds,
  linkOrigins,
  memberRoles,
  noteKinds,
  recordKinds,
  refTypes,
  reminderStates,
  reportKinds,
  reportStatuses,
  revisionKinds,
  routedBys,
  routingStatuses,
  syncStatuses,
  trustDomains,
  visibilities,
} from '@xjournal/core';
import { pgEnum } from 'drizzle-orm/pg-core';

// schema.md §2. Values come from @xjournal/core so Zod and Postgres share one list.
export const trustDomain = pgEnum('trust_domain', trustDomains);
export const memberRole = pgEnum('member_role', memberRoles);
export const visibility = pgEnum('visibility', visibilities);
export const inviteKind = pgEnum('invite_kind', inviteKinds);
export const deviceStatus = pgEnum('device_status', deviceStatuses);
export const inputTier = pgEnum('input_tier', inputTiers);
export const recordKind = pgEnum('record_kind', recordKinds);
export const noteKind = pgEnum('note_kind', noteKinds);
export const routingStatus = pgEnum('routing_status', routingStatuses);
export const routedBy = pgEnum('routed_by', routedBys);
export const revisionKind = pgEnum('revision_kind', revisionKinds);
export const reportKind = pgEnum('report_kind', reportKinds);
export const genPath = pgEnum('gen_path', genPaths);
export const changeReason = pgEnum('change_reason', changeReasons);
export const reportStatus = pgEnum('report_status', reportStatuses);
export const refType = pgEnum('ref_type', refTypes);
export const guidanceScope = pgEnum('guidance_scope', guidanceScopes);
export const linkOrigin = pgEnum('link_origin', linkOrigins);
export const reminderState = pgEnum('reminder_state', reminderStates);
export const syncStatus = pgEnum('sync_status', syncStatuses);
