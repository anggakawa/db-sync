import type { CheckIssue, Profile } from '../../shared/types';
import { isSameDatabase } from '../safety/same-database';
import type { EngineAdapter, SourceDatabase, TargetDatabase } from '../engines/adapter';

export interface CheckDeps {
  freeDiskBytes(path: string): Promise<number>;
  tmpRoot: string;
}

const FLAVOR_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' } as const;

function isOlder(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

export async function runChecks(
  profile: Profile, source: SourceDatabase, target: TargetDatabase, adapter: EngineAdapter, deps: CheckDeps,
): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  const s = await source.info();
  const t = await target.info();

  if (isSameDatabase(
    { host: profile.source.host, port: profile.source.port, database: profile.source.database, serverIdentity: s.identity },
    { host: profile.target.host, port: profile.target.port, database: profile.target.database, serverIdentity: t.identity },
  )) {
    issues.push({ severity: 'blocker', code: 'same-database', message: 'The source and the target are the same database.' });
  }
  if (s.flavor !== t.flavor) {
    issues.push({
      severity: 'blocker', code: 'flavor-mismatch',
      message: `Dev is ${FLAVOR_LABEL[s.flavor]} but local is ${FLAVOR_LABEL[t.flavor]}. They must be the same kind of server.`,
    });
  } else if (isOlder(t.version, s.version)) {
    issues.push({
      severity: 'warning', code: 'target-older',
      message: `Local ${FLAVOR_LABEL[t.flavor]} ${t.versionLabel} is older than dev ${s.versionLabel}, so the restore may fail.`,
    });
  }
  if (!(await target.canCreateDatabase())) {
    issues.push({ severity: 'blocker', code: 'cannot-create-db', message: 'The local user cannot create databases.' });
  }
  const free = await deps.freeDiskBytes(deps.tmpRoot);
  if (free < (await source.sizeBytes()) + (await target.sizeBytes())) {
    issues.push({ severity: 'warning', code: 'low-disk', message: 'Free disk space may not be enough for this sync.' });
  }
  issues.push(...(await adapter.engineChecks(source, target)));
  return issues;
}
