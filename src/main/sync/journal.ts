import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { SyncPaths } from './paths';

export interface TargetId { host: string; port: number; database: string }
export interface Journal { profileId: string; hadTarget: boolean; backupAvailable: boolean; startedAt: string; target: TargetId }

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

/** The record exists but cannot be read. Treating it as absent could overwrite a good backup. */
export class JournalDamagedError extends Error {
  constructor(readonly path: string) {
    super(`The recovery record at ${path} is damaged.`);
    this.name = 'JournalDamagedError';
  }
}

export async function readJournal(paths: SyncPaths, id: string): Promise<Journal | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(paths.journal(id), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new JournalDamagedError(paths.journal(id));
    return parsed as Journal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof SyntaxError) throw new JournalDamagedError(paths.journal(id));
    throw err;
  }
}

export async function clearJournal(paths: SyncPaths, id: string): Promise<void> {
  await fs.rm(paths.journal(id), { force: true, maxRetries: 3, retryDelay: 100 });
}
