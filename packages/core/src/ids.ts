import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

/** A new ULID (26 chars, time-sortable). All hub IDs are generated in the app (schema.md §0). */
export function newId(): string {
  return next();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}
