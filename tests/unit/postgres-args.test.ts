import { describe, expect, it } from 'vitest';
import { conninfoDbname, dumpArgs, missingExtensions, restoreArgs, toolEnv } from '../../src/main/engines/postgres/args';
import { createPostgresAdapter } from '../../src/main/engines/postgres/postgres-adapter';
import type { Endpoint } from '../../src/shared/types';

const ep: Endpoint = { host: 'db.example.com', port: 5433, user: 'me', password: 's3cret-pw', database: 'app' };

describe('postgres args', () => {
  it('builds dump args', () => {
    const args = dumpArgs(ep, '/d');
    expect(args).toEqual(expect.arrayContaining(['--format=directory', '--jobs=4', '--no-password', '--verbose']));
    expect(args).toEqual(expect.arrayContaining(['--host=db.example.com', '--port=5433', '--username=me', '--file=/d']));
    expect(args).toContain("--dbname=dbname='app'");
  });
  it('builds restore args', () => {
    const args = restoreArgs(ep, '/d');
    expect(args).toEqual(expect.arrayContaining(
      ['--jobs=4', '--no-owner', '--no-privileges', '--exit-on-error', '--no-password']));
    expect(args).toContain("--dbname=dbname='app'");
    expect(args[args.length - 1]).toBe('/d');
  });
  it('never includes the password in args', () => {
    for (const args of [dumpArgs(ep, '/d'), restoreArgs(ep, '/d')]) {
      expect(args.join(' ')).not.toContain('s3cret-pw');
    }
  });
  it('quotes dbname as a conninfo value', () => {
    expect(conninfoDbname("a'b c")).toBe(String.raw`dbname='a\'b c'`);
    expect(conninfoDbname(String.raw`a\b`)).toBe(String.raw`dbname='a\\b'`);
  });
  it('keeps a database name that starts with a dash out of option position', () => {
    expect(dumpArgs({ ...ep, database: '-x' }, '/d')).toContain("--dbname=dbname='-x'");
  });
  it('sets PGSSLMODE from the ssl setting', () => {
    expect(toolEnv(ep, true).PGSSLMODE).toBe('require');
    expect(toolEnv(ep, false).PGSSLMODE).toBe('disable');
    expect(toolEnv(ep).PGSSLMODE).toBeUndefined();
    expect(toolEnv(ep, true).PGPASSWORD).toBe('s3cret-pw');
    expect('PGPASSWORD' in toolEnv({ ...ep, password: '' }, true)).toBe(false);
  });
  it('names extensions the target lacks', () => {
    expect(missingExtensions(['plpgsql', 'pgcrypto', 'postgis'], ['pgcrypto'])).toEqual(['postgis']);
    expect(missingExtensions(['plpgsql'], [])).toEqual([]);
  });
});

describe('blank connection values', () => {
  const adapter = createPostgresAdapter({ locate: { path: () => 'unused', pluginDir: () => null }, tmpRoot: 'unused' });
  it.each([
    ['host', { host: '  ' }, /host/i],
    ['user', { user: '' }, /user/i],
    ['database', { database: ' ' }, /database/i],
  ])('refuses a blank %s before connecting', async (_label, over, message) => {
    // A blank host would silently become localhost inside the driver.
    await expect(adapter.openTarget({ ...ep, ...over })).rejects.toThrow(message);
    await expect(adapter.openSource({ ...ep, ...over, ssl: false })).rejects.toThrow(message);
  });
});
