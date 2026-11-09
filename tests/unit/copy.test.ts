import { describe, expect, it } from 'vitest';
import { confirmRestoreText, confirmSyncText, formatDuration, outcomeText, stepLabel, visibleDetails } from '../../src/renderer/copy';
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

describe('copy while a sync is unfinished', () => {
  it.each(['untouched', 'replaced', 'restored-from-backup'] as TargetState[])('never says the data is fine for %s', (targetState) => {
    const cancelled = outcomeText({ status: 'cancelled', targetState }, true).body;
    const failed = outcomeText({ status: 'failed', step: 'check', message: 'x.', details: '', targetState }, true).body;
    for (const body of [cancelled, failed]) {
      expect(body).toContain('unfinished sync above still needs recovery');
      expect(body).not.toContain('was not changed');
      expect(body).not.toContain('restored');
    }
  });
  it('hides the replaced and restored texts for a success too', () => {
    const body = outcomeText({ status: 'success', durationMs: 1000, warnings: [], targetState: 'replaced' }, true).body;
    expect(body).toContain('still needs recovery');
  });
  it.each(['maybe-incomplete', 'removed-partial', 'recovery-failed'] as TargetState[])('keeps the %s text', (targetState) => {
    const unfinished = outcomeText({ status: 'cancelled', targetState }, true).body;
    expect(unfinished).toBe(outcomeText({ status: 'cancelled', targetState }, false).body);
  });
  it('hides a bare token in details and points to Edit', () => {
    expect(visibleDetails('password-unreadable')).toBe('');
    expect(visibleDetails('pg_dump: boom\nline 2')).toBe('pg_dump: boom\nline 2');
    const o: SyncOutcome = { status: 'failed', step: 'check', message: 'Cannot read.', details: 'password-unreadable', targetState: 'untouched' };
    expect(outcomeText(o).body).toContain('Re-enter the password for this profile.');
  });
});
