import { describe, expect, it } from 'vitest';
import { confirmRestoreText, confirmSyncText, formatDuration, outcomeText, stepLabel } from '../../src/renderer/copy';
import type { ProfileView, SyncOutcome, TargetState } from '../../src/shared/types';

const view: ProfileView = {
  id: 'orders', name: 'Orders', engine: 'postgres', backupEnabled: true,
  source: { host: 'dev-db', port: 5432, user: 'ro', database: 'orders', ssl: true, hasPassword: true, passwordUnreadable: false },
  target: { host: 'localhost', port: 5433, user: 'me', database: 'orders', hasPassword: true, passwordUnreadable: false },
  lastResult: null, hasBackup: true, hasUnfinishedSync: false,
};

describe('copy', () => {
  it('names source and target in the confirmation', () =>
    expect(confirmSyncText(view)).toBe('Overwrite `orders` on `localhost:5433` with `orders` from `dev-db:5432`?'));

  it('names the target in the restore confirmation', () =>
    expect(confirmRestoreText(view)).toBe('Replace `orders` on `localhost:5433` with your previous local data?'));

  it('formats a duration', () => {
    expect(formatDuration(372_000)).toBe('6m 12s');
    expect(formatDuration(45_400)).toBe('45s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });

  it('labels every step', () => {
    expect(['check', 'download', 'backup', 'replace', 'verify'].map((s) => stepLabel(s as never)))
      .toEqual(['Check', 'Download', 'Back up local', 'Replace', 'Verify']);
  });

  it('titles a successful sync with its duration', () =>
    expect(outcomeText({ status: 'success', durationMs: 372_000, warnings: [], targetState: 'replaced' }).title).toBe('Done in 6m 12s'));

  it.each([
    ['restored-from-backup', 'Your previous local data was restored.'],
    ['untouched', 'Your local database was not changed.'],
    ['removed-partial', 'The partial local database was removed.'],
    ['maybe-incomplete', 'Your local database may be incomplete. Run another sync.'],
  ] as Array<[TargetState, string]>)('explains target state %s', (targetState, text) => {
    const failed: SyncOutcome = { status: 'failed', step: 'replace', message: 'Boom.', details: '', targetState };
    expect(outcomeText(failed).body).toContain(text);
    expect(outcomeText({ status: 'cancelled', targetState }).body).toContain(text);
  });

  it('recovery-failed gives the backup location', () => {
    const o: SyncOutcome = { status: 'failed', step: 'replace', message: 'Boom.', details: '', targetState: 'recovery-failed', backupPath: 'C:\data\backup' };
    expect(outcomeText(o).body).toContain('C:\data\backup');
  });

  it('titles failures and cancellations', () => {
    expect(outcomeText({ status: 'cancelled', targetState: 'untouched' }).title).toBe('Sync cancelled');
    expect(outcomeText({ status: 'failed', step: 'download', message: 'x', details: '', targetState: 'untouched' }).title).toBe('Sync failed');
  });
});
