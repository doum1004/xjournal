import { isTimeZone, systemTimeZone } from '@xjournal/core';
import { type HubDb, type LocalOwner, localRepo } from '@xjournal/db';
import { ServiceError } from './errors';

// Local mode (spec §11.1): one user. `hub init` creates them; the server acts as them.

export interface InitOptions {
  name?: string;
  timeZone?: string;
}

export async function initLocal(
  db: HubDb,
  opts: InitOptions = {},
): Promise<{ owner: LocalOwner; created: boolean }> {
  const timeZone = opts.timeZone ?? systemTimeZone();
  if (!isTimeZone(timeZone)) {
    throw new ServiceError(400, 'bad_request', `Unknown time zone: ${timeZone}`);
  }
  const name = opts.name?.trim() || process.env.USERNAME || process.env.USER || 'Me';
  return localRepo.bootstrapLocal(db, { displayName: name, timeZone });
}

/** The local owner, or a `not_initialized` error telling the user to run `hub init`. */
export async function localOwner(db: HubDb): Promise<LocalOwner> {
  const owner = await localRepo.findLocalOwner(db);
  if (!owner) {
    throw new ServiceError(409, 'not_initialized', 'The hub is not set up yet. Run `hub init`.');
  }
  return owner;
}
