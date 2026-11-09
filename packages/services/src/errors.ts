import type { z } from 'zod';

/** Stable error codes from api.md §7. */
export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden_role'
  | 'not_found'
  | 'conflict'
  | 'not_initialized'
  | 'internal';

/** A failure the adapters (REST, CLI, MCP) turn into a problem response or message. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export const notFound = (what = 'Not found') => new ServiceError(404, 'not_found', what);
export const forbidden = (why: string) => new ServiceError(403, 'forbidden_role', why);
export const conflict = (why: string) => new ServiceError(409, 'conflict', why);

/** Parse `input` with `schema`, or throw a 400 listing each problem. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new ServiceError(
    400,
    'bad_request',
    'Invalid input',
    r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}
