import { describe, expect, it } from 'vitest';
import { runChecks } from '../../src/main/sync/checks';
import type { Profile } from '../../src/shared/types';
import { createFakeAdapter, pgInfo, type FakeConfig } from '../support/fake-adapter';

const profile: Profile = {
  id: 'p1', name: 'P', engine: 'postgres', backupEnabled: true,
  source: { host: 'dev.example.com', port: 5432, user: 'u', password: 'x', database: 'app', ssl: true },
  target: { host: 'localhost', port: 5432, user: 'u', password: 'x', database: 'app' },
};

async function issuesFor(overrides: Partial<FakeConfig>, free = 1_000_000, p: Profile = profile) {
  const fake = createFakeAdapter(overrides);
  const source = await fake.adapter.openSource(p.source);
  const target = await fake.adapter.openTarget(p.target);
  return runChecks(p, source, target, fake.adapter, { freeDiskBytes: async () => free, tmpRoot: 'tmp' });
}

describe('runChecks', () => {
  it.each<[string, Partial<FakeConfig>, string, 'blocker' | 'warning', number?, Profile?]>([
    ['same database', { sourceInfo: pgInfo(16, 'same'), targetInfo: pgInfo(16, 'same') }, 'same-database', 'blocker'],
    ['mysql source, mariadb target', {
      sourceInfo: { flavor: 'mysql', version: [8, 0], versionLabel: '8.0', identity: 'a' },
      targetInfo: { flavor: 'mariadb', version: [10, 11], versionLabel: '10.11', identity: 'b' },
    }, 'flavor-mismatch', 'blocker'],
    ['user cannot create databases', { canCreate: false }, 'cannot-create-db', 'blocker'],
    ['target 15, source 17', { sourceInfo: pgInfo(17, 'a'), targetInfo: pgInfo(15, 'b') }, 'target-older', 'warning'],
    ['free disk < source + target', { sourceSize: 600, targetSize: 600 }, 'low-disk', 'warning', 1000],
  ])('%s gives %s', async (_name, overrides, code, severity, free) => {
    const issues = await issuesFor(overrides, free);
    expect(issues.filter((i) => i.code === code)).toEqual([expect.objectContaining({ code, severity })]);
  });

  it('words the target-older warning with the flavor label and both versions', async () => {
    const issues = await issuesFor({ sourceInfo: pgInfo(17, 'a'), targetInfo: pgInfo(15, 'b') });
    expect(issues.find((i) => i.code === 'target-older')?.message)
      .toBe('Local PostgreSQL 15 is older than dev 17, so the restore may fail.');
  });

  it('includes issues from adapter.engineChecks', async () => {
    const extra = { severity: 'warning' as const, code: 'engine-thing', message: 'm' };
    expect(await issuesFor({ engineIssues: [extra] })).toContainEqual(extra);
  });

  it('gives no issues for matching healthy servers', async () => {
    expect(await issuesFor({})).toEqual([]);
  });
});

describe('same-database detection on servers that ignore case', () => {
  const sameServer = { sourceInfo: pgInfo(16, 'one-server'), targetInfo: pgInfo(16, 'one-server') };
  const mixed: Profile = {
    ...profile,
    source: { ...profile.source, database: 'MyDb' },
    target: { ...profile.target, database: 'mydb' },
  };

  it('blocks MyDb and mydb on one server when the server folds names', async () => {
    const issues = await issuesFor({ ...sameServer, foldDatabaseNames: true }, 1_000_000, mixed);
    expect(issues.filter((i) => i.code === 'same-database')).toHaveLength(1);
  });

  it('keeps MyDb and mydb apart when the server is case-sensitive', async () => {
    const issues = await issuesFor({ ...sameServer, foldDatabaseNames: false }, 1_000_000, mixed);
    expect(issues.filter((i) => i.code === 'same-database')).toEqual([]);
  });
});
