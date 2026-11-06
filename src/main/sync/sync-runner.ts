import { promises as fs } from 'node:fs';
import type { CheckIssue, Engine, Profile, SyncEvent, SyncOutcome, SyncStep, TargetState } from '../../shared/types';
import {
  DropBlockedError, type CreateOptions, type EngineAdapter, type SourceDatabase, type StepContext, type TargetDatabase,
} from '../engines/adapter';
import type { GuardResult } from '../safety/target-guard';
import { runChecks } from './checks';
import type { SyncPaths } from './paths';

export interface RunnerDeps {
  adapterFor(engine: Engine): EngineAdapter;
  paths: SyncPaths;
  checkTarget(host: string): Promise<GuardResult>;
  freeDiskBytes(path: string): Promise<number>;
  stallLimitMs?: number; // default 300_000; enforced in Task 7
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

const removeQuietly = (path: string) => fs.rm(path, { recursive: true, force: true });
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function createSyncRunner(deps: RunnerDeps) {
  const now = deps.now ?? Date.now;
  const { paths } = deps;

  async function sync(profile: Profile, cb: RunCallbacks): Promise<SyncOutcome> {
    const startedAt = now();
    const id = profile.id;
    let step: SyncStep = 'check';
    let dropped = false;
    let backupPath: string | undefined;
    let source: SourceDatabase | undefined;
    let target: TargetDatabase | undefined;

    const enter = (next: SyncStep) => {
      cb.signal.throwIfAborted();
      step = next;
      cb.onEvent({ type: 'step', step });
    };
    const ctx: StepContext = {
      signal: cb.signal,
      onLog: (line) => cb.onEvent({ type: 'log', line }),
      onProgress: (label, percent) => cb.onEvent({ type: 'progress', label, percent }),
    };
    const targetState = (): TargetState => (dropped ? 'maybe-incomplete' : 'untouched');

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
      await source.dump(paths.tmpDump(id), ctx);

      const targetExists = await target.exists();
      if (profile.backupEnabled && targetExists) {
        enter('backup');
        await takeBackup(id, target, ctx);
        backupPath = paths.backupLatest(id);
      }

      enter('replace');
      const createOptions = await source.createOptions();
      if (targetExists) {
        const again = await deps.checkTarget(profile.target.host);
        if (!again.allowed) throw new StepFailure('replace', again.reason, 'target-not-local');
        await target.dropDatabase(ctx);
        dropped = true;
      }
      await target.createDatabase(createOptions);
      dropped = true;
      await target.restore(paths.tmpDump(id), ctx);

      enter('verify');
      const extra: CheckIssue[] = [];
      if (!sameList(await source.listTables(), await target.listTables())) {
        extra.push({
          severity: 'warning', code: 'tables-differ',
          message: 'Local tables differ from dev. Dev may have changed after the copy started.',
        });
      }
      return { status: 'success', durationMs: now() - startedAt, warnings: [...warnings, ...extra], targetState: 'replaced' };
    } catch (err) {
      if (cb.signal.aborted) {
        return { status: 'cancelled', targetState: targetState(), ...(backupPath && { backupPath }) };
      }
      if (err instanceof StepFailure) {
        return { status: 'failed', step: err.step, message: err.message, details: err.details, targetState: targetState(), ...(backupPath && { backupPath }) };
      }
      const message = err instanceof Error ? err.message : String(err);
      const details = err instanceof DropBlockedError
        ? `Connected clients: ${err.clients.join(', ')}`
        : err instanceof Error ? (err.stack ?? message) : message;
      return { status: 'failed', step, message, details, targetState: targetState(), ...(backupPath && { backupPath }) };
    } finally {
      await removeQuietly(paths.tmpDump(id));
      await source?.close().catch(() => undefined);
      await target?.close().catch(() => undefined);
    }
  }

  /** Writes the backup beside the current one and swaps it in only after it completes. */
  async function takeBackup(id: string, target: TargetDatabase, ctx: StepContext): Promise<void> {
    const options: CreateOptions = await target.createOptions();
    await fs.mkdir(paths.backupDir(id), { recursive: true });
    await removeQuietly(paths.backupIncoming(id));
    try {
      await target.dump(paths.backupIncoming(id), ctx);
    } catch (err) {
      await removeQuietly(paths.backupIncoming(id));
      throw err;
    }
    await removeQuietly(paths.backupPrevious(id));
    await fs.rename(paths.backupLatest(id), paths.backupPrevious(id)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await fs.rename(paths.backupIncoming(id), paths.backupLatest(id));
    await fs.writeFile(paths.backupMeta(id), JSON.stringify({ createOptions: options, takenAt: now() }));
    await removeQuietly(paths.backupPrevious(id));
  }

  const notImplemented = (): never => { throw new Error('not implemented'); };

  return { sync, restoreBackup: notImplemented as RestoreFn, recover: notImplemented as RestoreFn };
}

type RestoreFn = (profile: Profile, callbacks: RunCallbacks) => Promise<SyncOutcome>;
