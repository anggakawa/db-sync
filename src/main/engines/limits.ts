import type { Endpoint } from '../../shared/types';

export const METADATA_TIMEOUT_MS = 60_000;
export const DDL_TIMEOUT_MS = 5 * 60_000;
export const END_TIMEOUT_MS = 5_000;

export class QueryTimeoutError extends Error {
  constructor(seconds: number) {
    super(`The database did not answer within ${seconds} seconds.`);
    this.name = 'QueryTimeoutError';
  }
}

/** A blank value would be replaced by a default (localhost, the OS user) inside the driver, so refuse it up front. */
export function requireEndpoint(ep: Endpoint): void {
  const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';
  if (blank(ep.host)) throw new Error('The host is required.');
  if (blank(ep.user)) throw new Error('The user is required.');
  if (blank(ep.database)) throw new Error('The database name is required.');
}
