import { promises as fs } from 'node:fs';
import type { CheckIssue, Engine, Profile, SyncEvent, SyncOutcome, SyncStep, TargetState } from '../../shared/types';
import {
  DropBlockedError, type CreateOptions, type EngineAdapter, type SourceDatabase, type StepContext, type TargetDatabase,
} from '../engines/adapter';
import type { GuardResult } from '../safety/target-guard';
import { runChecks } from './checks';
import { describeFailure } from './failure-copy';
import { clearJournal, readJournal, writeJournal, type Journal } from './journal';
import type { SyncPaths } from './paths';
import { applyBackup, loadBackup, recoverTarget, recoveryTouchesTarget } from './recovery';
import { sizeOf, watchStall } from './stall-watch';

export interface RunnerDeps {
  adapterFor(engine: Engine): EngineAdapter;
  paths: SyncPaths;
  checkTarget(host: string): Promise<GuardResult>;
  freeDiskBytes(path: string): Promise<number>;
  stallLimitMs?: number; // default 300_000
  stallPollMs?: number; // default 10_000
  now?(): number;
}
export interface RunCallbacks {
  signal: AbortSignal;
  onEvent(event: SyncEvent): void;
  confirmWarnings(issues: CheckIssue[]): Promise<boolean>;
}

/** Thrown to leave the run with a failed outcome that is already fully described. */
class StepFailure extends Error {
  constructor(readonly step: SyncStep, message: string, readonly details: string) { super(message); }
}

/** Never rejects: a removal that fails (EBUSY, EPERM) is logged and the run carries on. Backups may be directories. */
async function removeQuietly(path: string, onLog?: (line: string) => void): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch (err) {
    onLog?.(`Could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const errText = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
const stallText = (ms: number) =>
  (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute(s)` : `${Math.max(1, Math.round(ms / 1000))} second(s)`);
const blockedMessage = (clients: string[]) =>
  `Other programs are connected to the local database (${clients.join(', ')}). Close them and try again. Nothing was deleted.`;

export function createSyncRunner(deps: RunnerDeps) {
  const now = deps.now ?? Date.now;
  const { paths } = deps;

  /** The journal is only a safety net, so a failed removal is logged and ignored. */
  async function clearJournalQuietly(id: string, onLog: (line: string) => void): Promise<void> {
    try { await clearJournal(paths, id); } catch (err) {
      onLog(`Could not remove the journal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /** Runs right before anything touches the target, however long ago the last check was. */
  async function ensureLocal(host: string): Promise<void> {
    const g = await deps.checkTarget(host);
    if (!g.allowed) throw new Error(g.reason);
  }
  async function closeAll(dbs: Array<{ close(): Promise<void> } | undefined>, onLog: (line: string) => void): Promise<void> {
    for (const db of dbs) {
      try { await db?.close(); } catch (err) { onLog(`Could not close a connection: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
  const contextFor = (cb: RunCallbacks, signal: AbortSignal): StepContext => ({
    signal,
    onLog: (line) => cb.onEvent({ type: 'log', line }),
    onProgress: (label, percent) => cb.onEvent({ type: 'progress', label, percent }),
  });

  async function sync(profile: Profile, cb: RunCallbacks): Promise<SyncOutcome> {
    const startedAt = now();
    const id = profile.id;
    let step: SyncStep = 'check';
    let touched = false; // the target may have been dropped or created
    let restored = false;
    let journal: Journal | undefined;
    let backupPath: string | undefined;
    let source: SourceDatabase | undefined;
    let target: TargetDatabase | undefined;

    const enter = (next: SyncStep) => {
      cb.signal.throwIfAborted();
      step = next;
      cb.onEvent({ type: 'step', step });
    };
    const ctx = contextFor(cb, cb.signal);

    try {
      enter('check');
      const guard = await deps.checkTarget(profile.target.host);
      if (!guard.allowed) throw new StepFailure('check', guard.reason, 'target-not-local');

      const adapter = deps.adapterFor(profile.engine);
      source = await adapter.openSource(profile.source);
      target = await adapter.openTarget(profile.target);
      await fs.mkdir(paths.tmpRoot, { recursive: true });

      const issues = await runChecks(profile, source, target, adapter, {
        freeDiskBytes: deps.freeDiskBytes, tmpRoot: paths.tmpRoot,
      });
      const blockers = issues.filter((i) => i.severity === 'blocker');
      if (blockers.length > 0) {
        throw new StepFailure('check', blockers.map((b) => b.message).join(' '), blockers.map((b) => b.code).join(', '));
      }
      const warnings = issues.filter((i) => i.severity === 'warning');
      if (warnings.length > 0 && !(await cb.confirmWarnings(warnings))) {
        return { status: 'cancelled', targetState: 'untouched' };
      }

      enter('download');
      const stallMs = deps.stallLimitMs ?? 300_000;
      const stall = new AbortController();
      let stalled = false;
      const stopWatch = watchStall(
        () => sizeOf(paths.tmpDump(id)), stallMs, () => { stalled = true; stall.abort(); }, deps.stallPollMs,
      );
      try {
        await source.dump(paths.tmpDump(id), { ...ctx, signal: AbortSignal.any([cb.signal, stall.signal]) });
      } catch (err) {
        if (stalled && !cb.signal.aborted) {
          throw new StepFailure(
            'download',
            `Downloading from dev stopped: no new data for ${stallText(stallMs)}. Nothing local was changed. Check that dev is reachable, then try again.`,
            'download-stalled',
          );
        }
        throw err;
      } finally {
        stopWatch();
      }

      const targetExists = await target.exists();
      if (profile.backupEnabled && targetExists) {
        enter('backup');
        await takeBackup(id, target, ctx);
        backupPath = paths.backupLatest(id);
      }

      enter('replace');
      const createOptions = await source.createOptions();
      const again = await deps.checkTarget(profile.target.host);
      if (!again.allowed) throw new StepFailure('replace', again.reason, 'target-not-local');
      cb.signal.throwIfAborted();
      journal = {
        profileId: id, hadTarget: targetExists, backupAvailable: backupPath !== undefined,
        startedAt: new Date(now()).toISOString(),
      };
      await writeJournal(paths, journal);
      // From here the target may change; only a blocked drop proves nothing was deleted.
      touched = true;
      if (targetExists) {
        try {
          await target.dropDatabase(ctx);
        } catch (err) {
          if (err instanceof DropBlockedError) {
            touched = false;
            await clearJournalQuietly(id, ctx.onLog);
          }
          throw err;
        }
      }
      await target.createDatabase(createOptions);
      await target.restore(paths.tmpDump(id), ctx);
      restored = true;
      await clearJournalQuietly(id, ctx.onLog);

      // The restore finished, so a cancel or a read problem from here on no longer changes the outcome.
      step = 'verify';
      cb.onEvent({ type: 'step', step });
      const extra: CheckIssue[] = [];
      try {
        if (!sameList(await source.listTables(), await target.listTables())) {
          extra.push({
            severity: 'warning', code: 'tables-differ',
            message: 'Local tables differ from dev. Dev may have changed after the copy started.',
          });
        }
      } catch {
        extra.push({
          severity: 'warning', code: 'verify-failed',
          message: 'Could not compare tables with dev. The local copy was restored but not checked.',
        });
      }
      return { status: 'success', durationMs: now() - startedAt, warnings: [...warnings, ...extra], targetState: 'replaced' };
    } catch (err) {
      const cancelled = cb.signal.aborted && !restored;
      const keep = backupPath ? { backupPath } : {};

      let failure: { step: SyncStep; message: string; details: string } | null = null;
      if (!cancelled) {
        if (err instanceof StepFailure) {
          failure = { step: err.step, message: err.message, details: err.details };
        } else if (err instanceof DropBlockedError) {
          failure = { step, message: blockedMessage(err.clients), details: `Connected clients: ${err.clients.join(', ')}` };
        } else {
          const info = (db: SourceDatabase | TargetDatabase | undefined) => (db ? db.info().catch(() => null) : Promise.resolve(null));
          failure = { step, ...describeFailure(step, err, await info(source), await info(target)) };
        }
      }

      let targetState: TargetState = touched ? 'maybe-incomplete' : 'untouched';
      if (touched && !restored && target && journal) {
        // Recovery must run to completion, so it gets its own signal rather than the cancelled one.
        try {
          if (recoveryTouchesTarget(journal)) await ensureLocal(profile.target.host);
          const rec = await recoverTarget(target, journal, paths, contextFor(cb, new AbortController().signal));
          targetState = rec.targetState;
          await clearJournalQuietly(id, ctx.onLog);
        } catch (recErr) {
          return {
            status: 'failed', step: 'replace', targetState: 'recovery-failed', ...keep,
            message: `The sync failed and the previous local data could not be restored automatically.${backupPath ? ` Your backup is kept at ${backupPath}.` : ''}`,
            details: `${failure?.details ?? 'The sync was cancelled.'}\n\nRecovery failed: ${errText(recErr)}`,
          };
        }
      }
      if (cancelled) return { status: 'cancelled', targetState, ...keep };
      return { status: 'failed', ...failure!, targetState, ...keep };
    } finally {
      await removeQuietly(paths.tmpDump(id), ctx.onLog);
      await closeAll([source, target], ctx.onLog);
    }
  }

  /** Writes the backup beside the current one and swaps it in only after it completes. */
  async function takeBackup(id: string, target: TargetDatabase, ctx: StepContext): Promise<void> {
    const options: CreateOptions = await target.createOptions();
    await fs.mkdir(paths.backupDir(id), { recursive: true });
    await removeQuietly(paths.backupIncoming(id), ctx.onLog);
    try {
      await target.dump(paths.backupIncoming(id), ctx);
    } catch (err) {
      await removeQuietly(paths.backupIncoming(id), ctx.onLog);
      throw err;
    }
    // Recovery reads meta.json, so it is written whole or not at all: temp file first, renamed after the swap.
    const metaTmp = `${paths.backupMeta(id)}.tmp`;
    try {
      await fs.writeFile(metaTmp, JSON.stringify({ createOptions: options, takenAt: now() }));
    } catch (e) {
      await removeQuietly(metaTmp, ctx.onLog);
      await removeQuietly(paths.backupIncoming(id), ctx.onLog);
      throw e;
    }
    await removeQuietly(paths.backupPrevious(id), ctx.onLog);
    let movedPrevious = false;
    // Puts the old backup back so a failed swap never loses it.
    const rollback = async () => {
      if (movedPrevious) {
        await removeQuietly(paths.backupLatest(id), ctx.onLog);
        await fs.rename(paths.backupPrevious(id), paths.backupLatest(id)).catch((re: unknown) =>
          ctx.onLog(`Could not put the previous backup back: ${re instanceof Error ? re.message : String(re)}`));
      }
      await removeQuietly(paths.backupIncoming(id), ctx.onLog);
      await removeQuietly(metaTmp, ctx.onLog);
    };
    try {
      try {
        await fs.rename(paths.backupLatest(id), paths.backupPrevious(id));
        movedPrevious = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await fs.rename(paths.backupIncoming(id), paths.backupLatest(id));
      await fs.rename(metaTmp, paths.backupMeta(id));
    } catch (e) {
      await rollback();
      throw e;
    }
    await removeQuietly(paths.backupPrevious(id), ctx.onLog);
  }

  const failed = (message: string, details: string, targetState: TargetState, backupPath?: string): SyncOutcome =>
    ({ status: 'failed', step: 'replace', message, details, targetState, ...(backupPath && { backupPath }) });

  /** Restores the kept backup over the target. Takes no new backup and keeps the old one. */
  async function restoreBackup(profile: Profile, cb: RunCallbacks): Promise<SyncOutcome> {
    const startedAt = now();
    const ctx = contextFor(cb, cb.signal);
    let target: TargetDatabase | undefined;
    let touched = false;
    let backupPath: string | undefined;
    try {
      cb.onEvent({ type: 'step', step: 'replace' });
      const backup = await loadBackup(paths, profile.id);
      backupPath = backup.path;
      await ensureLocal(profile.target.host);
      target = await deps.adapterFor(profile.engine).openTarget(profile.target);
      cb.signal.throwIfAborted();
      touched = true;
      try {
        await applyBackup(target, backup, ctx);
      } catch (err) {
        if (err instanceof DropBlockedError) touched = false;
        throw err;
      }
      return { status: 'success', durationMs: now() - startedAt, warnings: [], targetState: 'restored-from-backup' };
    } catch (err) {
      const targetState: TargetState = touched ? 'maybe-incomplete' : 'untouched';
      if (cb.signal.aborted) return { status: 'cancelled', targetState, ...(backupPath && { backupPath }) };
      if (err instanceof DropBlockedError) {
        return failed(blockedMessage(err.clients), `Connected clients: ${err.clients.join(', ')}`, targetState, backupPath);
      }
      const d = describeFailure('replace', err, null, null);
      return failed(backupPath ? d.message : 'There is no previous local data to restore.', d.details, targetState, backupPath);
    } finally {
      await closeAll([target], ctx.onLog);
    }
  }

  /** Finishes a sync that was interrupted by the app closing, using the journal. */
  async function recover(profile: Profile, cb: RunCallbacks): Promise<SyncOutcome> {
    const startedAt = now();
    const id = profile.id;
    const ctx = contextFor(cb, new AbortController().signal); // recovery is not cancellable
    let target: TargetDatabase | undefined;
    let backupPath: string | undefined;
    try {
      const journal = await readJournal(paths, id);
      if (!journal) return failed('There is no unfinished sync to recover.', 'no-journal', 'untouched');
      if (journal.backupAvailable) backupPath = paths.backupLatest(id);
      cb.onEvent({ type: 'step', step: 'replace' });
      if (recoveryTouchesTarget(journal)) await ensureLocal(profile.target.host);
      target = await deps.adapterFor(profile.engine).openTarget(profile.target);
      const rec = await recoverTarget(target, journal, paths, ctx);
      await clearJournalQuietly(id, ctx.onLog);
      if (rec.targetState === 'restored-from-backup' || rec.targetState === 'removed-partial') {
        return { status: 'success', durationMs: now() - startedAt, warnings: [], targetState: rec.targetState };
      }
      return failed(
        'The sync was interrupted and the local database may be incomplete. Run a sync again to replace it.',
        'The backup was turned off, so there is nothing to restore.', 'maybe-incomplete',
      );
    } catch (err) {
      return {
        status: 'failed', step: 'replace', targetState: 'recovery-failed', ...(backupPath && { backupPath }),
        message: `The previous local data could not be restored automatically.${backupPath ? ` Your backup is kept at ${backupPath}.` : ''}`,
        details: describeFailure('replace', err, null, null).details,
      };
    } finally {
      await closeAll([target], ctx.onLog);
    }
  }

  return { sync, restoreBackup, recover };
}
