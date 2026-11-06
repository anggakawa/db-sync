import { describe, expect, it } from 'vitest';
import { isSameDatabase } from '../../src/main/safety/same-database';

const a = { host: 'localhost', port: 5432, database: 'x', serverIdentity: null };
describe('isSameDatabase', () => {
  it('treats loopback names as the same host', () => expect(isSameDatabase(a, { ...a, host: '::1' })).toBe(true));
  it('matches on server identity across hosts', () => expect(isSameDatabase(
    { ...a, host: 'dev', serverIdentity: 'u1' }, { ...a, serverIdentity: 'u1' })).toBe(true));
  it('differs on port with no identity', () => expect(isSameDatabase(a, { ...a, port: 5433 })).toBe(false));
  it('differs on database name with matching identity', () => expect(isSameDatabase(
    { ...a, serverIdentity: 'u1' }, { ...a, database: 'y', serverIdentity: 'u1' })).toBe(false));
  it('differs on host and port with no identity', () => expect(isSameDatabase(a, { ...a, host: 'dev' })).toBe(false));
  it('differs when identities differ even on the same host and port', () => expect(isSameDatabase(
    { ...a, serverIdentity: 'u1' }, { ...a, serverIdentity: 'u2' })).toBe(false));
  it('falls back to host and port when only one side has an identity', () => expect(isSameDatabase(
    { ...a, serverIdentity: 'u1' }, a)).toBe(true));
});
