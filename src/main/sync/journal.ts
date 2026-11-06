import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { SyncPaths } from './paths';

export interface Journal { profileId: string; hadTarget: boolean; backupAvailable: boolean; startedAt: string }

/** Written atomically (temp file, then rename) so a crash never leaves a half-written journal. */
export async function writeJournal(paths: SyncPaths, j: Journal): Promise<void> {
  const file = paths.journal(j.profileId);
  const tmp = `${file}.tmp`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(j));
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readJournal(paths: SyncPaths, id: string): Promise<Journal | null> {
  try {
    return JSON.parse(await fs.readFile(paths.journal(id), 'utf8')) as Journal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function clearJournal(paths: SyncPaths, id: string): Promise<void> {
  await fs.rm(paths.journal(id), { force: true });
}
