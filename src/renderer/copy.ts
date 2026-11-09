import type { ProfileView, SyncOutcome, SyncStep, TargetState } from '../shared/types';

const at = (e: { host: string; port: number }) => `\`${e.host}:${e.port}\``;

export function confirmSyncText(p: ProfileView): string {
  return `Overwrite \`${p.target.database}\` on ${at(p.target)} with \`${p.source.database}\` from ${at(p.source)}?`;
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

function stateText(state: TargetState, backupPath?: string): string {
  switch (state) {
    case 'untouched': return 'Your local database was not changed.';
    case 'replaced': return 'Your local database was replaced with the copy from dev.';
    case 'restored-from-backup': return 'Your previous local data was restored.';
    case 'removed-partial': return 'The partial local database was removed.';
    case 'maybe-incomplete': return 'Your local database may be incomplete. Run another sync.';
    case 'recovery-failed':
      return backupPath
        ? `Your local database could not be put back automatically. Your previous data is saved at ${backupPath}.`
        : 'Your local database could not be put back automatically, and there is no backup. Run another sync.';
  }
}

export function outcomeText(o: SyncOutcome): { title: string; body: string } {
  if (o.status === 'success') {
    return { title: `Done in ${formatDuration(o.durationMs)}`, body: stateText(o.targetState) };
  }
  if (o.status === 'cancelled') {
    return { title: 'Sync cancelled', body: stateText(o.targetState, o.backupPath) };
  }
  return { title: 'Sync failed', body: `${o.message} ${stateText(o.targetState, o.backupPath)}` };
}

/** An error from the main process arrives as "Error invoking remote method '...': Error: message"; only the message is for people. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '');
}
