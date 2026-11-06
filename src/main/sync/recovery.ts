import { promises as fs } from 'node:fs';
import type { TargetState } from '../../shared/types';
import type { CreateOptions, StepContext, TargetDatabase } from '../engines/adapter';
import type { Journal } from './journal';
import type { SyncPaths } from './paths';

export interface StoredBackup { path: string; createOptions: CreateOptions }

/** Reads the backup's metadata and checks the backup exists. Throws before anything is changed. */
export async function loadBackup(paths: SyncPaths, id: string): Promise<StoredBackup> {
  const meta = JSON.parse(await fs.readFile(paths.backupMeta(id), 'utf8')) as { createOptions?: CreateOptions };
  await fs.stat(paths.backupLatest(id));
  return { path: paths.backupLatest(id), createOptions: meta.createOptions ?? {} };
}

/** Drops the target, creates it with the stored options and restores the backup. The backup is kept. */
export async function applyBackup(target: TargetDatabase, backup: StoredBackup, ctx: StepContext): Promise<void> {
  await target.dropDatabase(ctx);
  await target.createDatabase(backup.createOptions);
  await target.restore(backup.path, ctx);
}

/** True when recovery will change the target, so the target guard must run first. */
export const recoveryTouchesTarget = (j: Journal): boolean => j.backupAvailable || !j.hadTarget;

/** Throws when recovery itself fails; the caller keeps the backup and the journal. */
export async function recoverTarget(
  target: TargetDatabase, journal: Journal, paths: SyncPaths, ctx: StepContext,
): Promise<{ targetState: TargetState; backupPath?: string }> {
  if (journal.backupAvailable) {
    const backup = await loadBackup(paths, journal.profileId);
    await applyBackup(target, backup, ctx);
    return { targetState: 'restored-from-backup', backupPath: backup.path };
  }
  if (!journal.hadTarget) {
    await target.dropDatabase(ctx);
    return { targetState: 'removed-partial' };
  }
  return { targetState: 'maybe-incomplete' };
}
