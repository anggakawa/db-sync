import { promises as fs } from 'node:fs';
import type { ConnectionSide, ConnectionTestResult } from '../../shared/api';
import { PROFILE_ID, SyncBusyError } from '../../shared/api';
import type {
  CheckIssue, Profile, ProfileInput, ProfileView, SyncEvent, SyncOutcome,
} from '../../shared/types';
import type { EngineAdapter } from '../engines/adapter';
import {
  PasswordUnreadableError, resolveInput, toView, type ProfileEntry, type ProfileStore, type UnreadablePasswords,
} from '../profiles/profile-store';
import { redact } from '../process/redact';
import type { GuardResult } from '../safety/target-guard';
import { causeOf } from './failure-copy';
import { readJournal } from './journal';
import type { SyncPaths } from './paths';
import type { RunCallbacks } from './sync-runner';
import type { LogStore, RunKind, RunLog } from './sync-log';

export interface SyncRunner {
  sync(profile: Profile, cb: RunCallbacks): Promise<SyncOutcome>;
  restoreBackup(profile: Profile, cb: RunCallbacks): Promise<SyncOutcome>;
  recover(profile: Profile, cb: RunCallbacks): Promise<SyncOutcome>;
}

export interface SyncServiceDeps {
  store: ProfileStore;
  runner: SyncRunner;
  paths: SyncPaths;
  logs: LogStore;
  adapterFor(engine: Profile['engine']): EngineAdapter;
  checkTarget(host: string): Promise<GuardResult>;
  /** Already redacted. Goes to the renderer. */
  onEvent(profileId: string, event: SyncEvent): void;
  onWarnings(profileId: string, issues: CheckIssue[]): void;
}

export const TARGET_LOCKED_BY_JOURNAL = "Finish or recover the unfinished sync before changing this profile's target.";
const TARGET_LOCKED_BY_RUN = "Wait for the running sync to finish before changing this profile's target.";
const DELETE_LOCKED_BY_RUN = 'Wait for the running sync to finish before deleting this profile.';
const CLOSING = 'DB Sync is closing. Start it again to sync.';

interface ActiveRun {
  profileId: string;
  controller: AbortController;
  /** Resolves the warning question the UI is being asked, if any. */
  answer: ((accept: boolean) => void) | null;
  done: Promise<void>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('Invalid profile id.');
}

export function createSyncService(deps: SyncServiceDeps) {
  const { store, paths } = deps;
  let current: ActiveRun | null = null;
  let closing = false;

  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  /** True when a journal exists. A damaged or unreadable one counts: the target is in doubt. */
  async function hasUnfinishedSync(id: string): Promise<boolean> {
    try {
      return (await readJournal(paths, id)) !== null;
    } catch {
      return true;
    }
  }

  async function viewOf(entry: ProfileEntry): Promise<ProfileView> {
    const id = entry.profile.id;
    const [lastResult, hasBackup, unfinished] = await Promise.all([
      store.lastResult(id), exists(paths.backupLatest(id)), hasUnfinishedSync(id),
    ]);
    return toView(entry.profile, {
      lastResult, hasBackup, hasUnfinishedSync: unfinished, passwordUnreadable: entry.unreadable,
    });
  }

  function redactOutcome(o: SyncOutcome, secrets: string[]): SyncOutcome {
    const r = (text: string) => redact(text, secrets);
    if (o.status === 'failed') return { ...o, message: r(o.message), details: r(o.details) };
    if (o.status === 'success') return { ...o, warnings: o.warnings.map((w) => ({ ...w, message: r(w.message) })) };
    return o;
  }

  function describeOutcome(o: SyncOutcome): string {
    if (o.status === 'failed') return `Result: failed at ${o.step}. ${o.message}\n${o.details}\nTarget: ${o.targetState}`;
    if (o.status === 'cancelled') return `Result: cancelled. Target: ${o.targetState}`;
    return `Result: success in ${o.durationMs} ms. Target: ${o.targetState}`;
  }

  /** The one place a sync, a restore or a recovery runs, so all three share the single-run lock. */
  async function run(
    id: unknown, kind: RunKind, work: (profile: Profile, cb: RunCallbacks) => Promise<SyncOutcome>,
  ): Promise<SyncOutcome> {
    assertId(id);
    if (closing) throw new Error(CLOSING);
    if (current) throw new SyncBusyError();
    // No await between the check above and this line, so two callers can never both get in.
    const active: ActiveRun = { profileId: id, controller: new AbortController(), answer: null, done: Promise.resolve() };
    let finish!: () => void;
    active.done = new Promise<void>((resolve) => { finish = resolve; });
    current = active;

    let secrets: string[] = [];
    let log: RunLog | undefined;
    try {
      const entry = await store.getEntry(id);
      secrets = [entry.profile.source.password, entry.profile.target.password];
      log = await deps.logs.open(id, kind, secrets);
      const writeLog = log.write.bind(log);

      const callbacks: RunCallbacks = {
        signal: active.controller.signal,
        onEvent(event) {
          // Every line is redacted here, whichever step or recovery produced it, before the disk and the renderer.
          const safe: SyncEvent = event.type === 'log' ? { type: 'log', line: redact(event.line, secrets) }
            : event.type === 'progress' ? { type: 'progress', label: redact(event.label, secrets), percent: event.percent }
              : event;
          if (safe.type === 'log') writeLog(safe.line);
          else if (safe.type === 'step') writeLog(`Step: ${safe.step}`);
          try { deps.onEvent(id, safe); } catch { /* the window may be gone */ }
        },
        confirmWarnings(issues) {
          if (active.controller.signal.aborted) return Promise.resolve(false);
          return new Promise<boolean>((resolve) => {
            active.answer = resolve;
            const safe = issues.map((i) => ({ ...i, message: redact(i.message, secrets) }));
            for (const i of safe) writeLog(`Warning: ${i.message}`);
            try { deps.onWarnings(id, safe); } catch { /* the window may be gone */ }
          });
        },
      };

      const unreadable = unreadableFor(kind, entry.unreadable);
      let outcome: SyncOutcome;
      if (unreadable) {
        outcome = {
          status: 'failed', step: kind === 'sync' ? 'check' : 'replace', targetState: 'untouched',
          message: new PasswordUnreadableError(unreadable).message, details: 'password-unreadable',
        };
      } else {
        outcome = await work(entry.profile, callbacks);
      }
      outcome = redactOutcome(outcome, secrets);
      writeLog(describeOutcome(outcome));
      try {
        await store.setLastResult(id, outcome);
      } catch (err) {
        writeLog(`Could not save the result: ${redact(errorText(err), secrets)}`);
      }
      return outcome;
    } catch (err) {
      const message = redact(errorText(err), secrets);
      log?.write(`Error: ${message}`);
      throw new Error(message);
    } finally {
      await log?.close();
      current = null;
      finish();
    }
  }

  /** A sync uses both passwords; a restore or a recovery only the target's. */
  function unreadableFor(kind: RunKind, u: UnreadablePasswords): UnreadablePasswords | null {
    const sides = kind === 'sync' ? u : { source: false, target: u.target };
    return sides.source || sides.target ? sides : null;
  }

  async function targetPendingError(id: string, existing: Profile, input: ProfileInput): Promise<string | null> {
    const a = existing.target;
    const b = input.target;
    if (a.host === b.host && a.port === b.port && a.database === b.database) return null;
    if (current?.profileId === id) return TARGET_LOCKED_BY_RUN;
    return (await hasUnfinishedSync(id)) ? TARGET_LOCKED_BY_JOURNAL : null;
  }

  return {
    /** Run once at startup, before any sync. Removes every leftover in tmp, such as client-*.cnf files that hold a password. */
    async startup(): Promise<void> {
      await fs.rm(paths.tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },

    async listProfiles(): Promise<ProfileView[]> {
      return Promise.all((await store.listEntries()).map(viewOf));
    },

    async saveProfile(input: ProfileInput): Promise<ProfileView> {
      if (input.id !== undefined) assertId(input.id);
      if (input.id) {
        const existing = (await store.listEntries()).find((e) => e.profile.id === input.id);
        if (existing) {
          const problem = await targetPendingError(input.id, existing.profile, input);
          if (problem) throw new Error(problem);
        }
      }
      const saved = await store.save(input);
      return viewOf(await store.getEntry(saved.id));
    },

    /** Deleting is allowed with an unfinished sync; the renderer asks the user to confirm first. */
    async deleteProfile(id: string): Promise<void> {
      assertId(id);
      if (current?.profileId === id) throw new Error(DELETE_LOCKED_BY_RUN);
      await store.remove(id);
      const journal = paths.journal(id);
      for (const p of [paths.backupDir(id), paths.logsDir(id), journal, `${journal}.tmp`, paths.tmpDump(id)]) {
        await fs.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },

    async testConnection(input: ProfileInput, side: ConnectionSide): Promise<ConnectionTestResult> {
      if (input.id !== undefined) assertId(input.id);
      const entry = input.id ? (await store.listEntries()).find((e) => e.profile.id === input.id) : undefined;
      if (input[side].password === undefined && entry?.unreadable[side]) {
        return { ok: false, message: new PasswordUnreadableError({ source: side === 'source', target: side === 'target' }).message };
      }
      let profile: Profile;
      try {
        profile = resolveInput(input, entry?.profile ?? null);
      } catch (err) {
        return { ok: false, message: errorText(err) };
      }
      const secrets = [profile.source.password, profile.target.password];
      if (side === 'target') {
        const guard = await deps.checkTarget(profile.target.host);
        if (!guard.allowed) return { ok: false, message: guard.reason };
      }
      try {
        const adapter = deps.adapterFor(profile.engine);
        const db = side === 'source' ? await adapter.openSource(profile.source) : await adapter.openTarget(profile.target);
        try {
          const info = await db.info();
          return { ok: true, versionLabel: info.versionLabel, flavor: info.flavor };
        } finally {
          await db.close().catch(() => undefined);
        }
      } catch (err) {
        return { ok: false, message: redact(causeOf(err), secrets) };
      }
    },

    startSync: (id: string) => run(id, 'sync', (p, cb) => deps.runner.sync(p, cb)),
    restoreBackup: (id: string) => run(id, 'restore', (p, cb) => deps.runner.restoreBackup(p, cb)),
    recover: (id: string) => run(id, 'recover', (p, cb) => deps.runner.recover(p, cb)),

    async cancel(): Promise<void> {
      if (!current) return;
      current.controller.abort();
      current.answer?.(false);
      current.answer = null;
    },

    async answerWarnings(accept: boolean): Promise<void> {
      const answer = current?.answer;
      if (!current || !answer) return;
      current.answer = null;
      answer(accept);
    },

    hasRunningSync: () => current !== null,

    /** Resolves when no run is active, after any automatic recovery has finished. */
    async whenIdle(): Promise<void> {
      while (current) await current.done;
    },

    /** For quitting: refuses new runs, cancels the current one and waits for its outcome, recovery included. */
    async shutdown(): Promise<void> {
      closing = true;
      await this.cancel();
      await this.whenIdle();
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
