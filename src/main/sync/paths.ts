import { join } from 'node:path';

export interface SyncPaths {
  tmpRoot: string;
  tmpDump(id: string): string;
  backupDir(id: string): string;
  backupLatest(id: string): string;
  backupIncoming(id: string): string;
  backupPrevious(id: string): string;
  backupMeta(id: string): string;
  journal(id: string): string;
  logsDir(id: string): string;
  profilesFile: string;
}

export function createSyncPaths(root: string): SyncPaths {
  const tmpRoot = join(root, 'tmp');
  const backupDir = (id: string) => join(root, 'backups', id);
  return {
    tmpRoot,
    tmpDump: (id) => join(tmpRoot, `${id}.dump`),
    backupDir,
    backupLatest: (id) => join(backupDir(id), 'latest'),
    backupIncoming: (id) => join(backupDir(id), 'incoming'),
    backupPrevious: (id) => join(backupDir(id), 'previous'),
    backupMeta: (id) => join(backupDir(id), 'meta.json'),
    journal: (id) => join(root, 'journal', `${id}.json`),
    logsDir: (id) => join(root, 'logs', id),
    profilesFile: join(root, 'profiles.json'),
  };
}
