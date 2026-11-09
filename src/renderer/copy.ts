import type { ProfileView, SyncOutcome, SyncStep, TargetState } from '../shared/types';

const at = (e: { host: string; port: number }) => `\`${e.host}:${e.port}\``;

export function confirmSyncText(p: ProfileView): string {
  return `Overwrite \`${p.target.database}\` on ${at(p.target)} with \`${p.source.database}\` from ${at(p.source)}?`;
}

/** What the sync confirmation says about the backup; it must match what the sync will really do. */
export function confirmSyncNote(p: ProfileView): string {
  if (p.hasUnfinishedSync) return 'An earlier sync did not finish, so no new backup is taken. Choose Recover first to get your previous data back.';
  if (!p.backupEnabled) return 'Backups are off for this profile, so your local data is not backed up. If the sync fails, it cannot be put back.';
  return 'Your current local data is backed up first, and put back if the sync fails.';
}

export function confirmRestoreText(p: ProfileView): string {
  return `Replace \`${p.target.database}\` on ${at(p.target)} with your previous local data?`;
}

const STEPS: Record<SyncStep, string> = {
  check: 'Check', download: 'Download', backup: 'Back up local', replace: 'Replace', verify: 'Verify',
};
export const STEP_ORDER: SyncStep[] = ['check', 'download', 'backup', 'replace', 'verify'];

export function stepLabel(step: SyncStep): string {
  return STEPS[step];
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * A failed outcome's message carries the one next step and, after a failed recovery, the backup path.
 * Only a cancelled run has no message, so only it names a next step here.
 */
function stateText(state: TargetState, cancelled: boolean, backupPath: string | undefined, message: string): string {
  switch (state) {
    case 'untouched': return 'Your local database was not changed.';
    case 'replaced': return 'Your local database was replaced with the copy from dev.';
    case 'restored-from-backup': return 'Your previous local data was restored.';
    case 'removed-partial': return 'The partial local database was removed.';
    case 'maybe-incomplete':
      if (!cancelled) return 'Your local database may be incomplete.';
      return `Your local database may be incomplete. ${backupPath ? 'Choose Restore previous local data.' : 'Run another sync.'}`;
    case 'recovery-failed': {
      const saved = backupPath && !message.includes(backupPath) ? ` Your previous data is saved at ${backupPath}.` : '';
      return `Your local database could not be put back automatically.${saved}`;
    }
  }
}

const SAFE_WHILE_UNFINISHED: TargetState[] = ['maybe-incomplete', 'recovery-failed', 'removed-partial'];
const UNFINISHED_RUN = 'This run did not change anything. The unfinished sync above still needs recovery.';
const UNFINISHED_AFTER_RUN = 'The unfinished sync above still needs recovery before you rely on the local database.';

/** A bare machine token (for example 'password-unreadable') is not for people. */
export function visibleDetails(details: string): string {
  const d = details.trim();
  return /^[a-z]+(-[a-z]+)*$/.test(d) ? '' : d;
}

/**
 * While `unfinished` is true, only texts that say the local database may be damaged are shown as they are;
 * nothing may read as "your data is fine".
 */
export function outcomeText(o: SyncOutcome, unfinished = false): { title: string; body: string } {
  const title = o.status === 'success' ? `Done in ${formatDuration(o.durationMs)}` : o.status === 'cancelled' ? 'Sync cancelled' : 'Sync failed';
  const state = stateText(
    o.targetState, o.status === 'cancelled', o.status === 'success' ? undefined : o.backupPath, o.status === 'failed' ? o.message : '',
  );
  const hide = unfinished && !SAFE_WHILE_UNFINISHED.includes(o.targetState);
  if (o.status === 'success') return { title, body: hide ? UNFINISHED_AFTER_RUN : state };
  if (o.status === 'cancelled') return { title, body: hide ? UNFINISHED_RUN : state };
  const reread = o.details.trim() === 'password-unreadable' ? ' Re-enter the password for this profile.' : '';
  return { title, body: `${o.message}${reread} ${hide ? UNFINISHED_RUN : state}` };
}
