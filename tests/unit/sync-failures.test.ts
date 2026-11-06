import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fsp } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropBlockedError, type StepContext } from '../../src/main/engines/adapter';
import { ToolError } from '../../src/main/process/process-runner';
import { describeFailure } from '../../src/main/sync/failure-copy';
import { readJournal, writeJournal } from '../../src/main/sync/journal';
import { createSyncPaths, type SyncPaths } from '../../src/main/sync/paths';
import { createSyncRunner, type RunCallbacks } from '../../src/main/sync/sync-runner';
import type { GuardResult } from '../../src/main/safety/target-guard';
import type { Profile, SyncEvent, SyncStep } from '../../src/shared/types';
import { createFakeAdapter, pgInfo, type FakeConfig } from '../support/fake-adapter';

const profile: Profile = {
  id: 'p1', name: 'P', engine: 'postgres', backupEnabled: true,
  source: { host: 'dev.example.com', port: 5432, user: 'u', password: 'x', database: 'app', ssl: true },
  target: { host: 'localhost', port: 5432, user: 'u', password: 'x', database: 'app' },
};

let root: string;
let paths: SyncPaths;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'failures-')); paths = createSyncPaths(root); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const tgt = { host: 'localhost', port: 5432, database: 'app' };
const exists = (p: string) => stat(p).then(() => true, () => false);

function setup(overrides: Partial<FakeConfig> = {}, opts: { guard?: () => GuardResult; stallLimitMs?: number; stallPollMs?: number } = {}) {
  const fake = createFakeAdapter(overrides);
  const guardCalls: string[] = [];
  const runner = createSyncRunner({
    adapterFor: () => fake.adapter,
    paths,
    checkTarget: async (host) => { guardCalls.push(host); return opts.guard ? opts.guard() : { allowed: true }; },
    freeDiskBytes: async () => 1_000_000,
    now: (() => { let t = 0; return () => (t += 10); })(),
    stallLimitMs: opts.stallLimitMs,
    stallPollMs: opts.stallPollMs,
  });
  const events: SyncEvent[] = [];
  const callbacks = (signal: AbortSignal = new AbortController().signal): RunCallbacks => ({
    signal, onEvent: (e) => events.push(e), confirmWarnings: async () => true,
  });
  return { fake, runner, events, callbacks, guardCalls };
}

/** Records, per call to the target's restore, whether the signal it got was already aborted. */
function watchSignals(fake: ReturnType<typeof createFakeAdapter>) {
  const aborted: boolean[] = [];
  const open = fake.adapter.openTarget;
  fake.adapter.openTarget = async (e) => {
    const t = await open(e);
    const restore = t.restore;
    t.restore = async (p, ctx: StepContext) => { aborted.push(ctx.signal.aborted); return restore(p, ctx); };
    return t;
  };
  return aborted;
}

const writeBackup = async (content = 'old backup', options: object = { encoding: 'LATIN1' }) => {
  await mkdir(paths.backupDir(profile.id), { recursive: true });
  await writeFile(paths.backupLatest(profile.id), content);
  await writeFile(paths.backupMeta(profile.id), JSON.stringify({ createOptions: options, takenAt: 1, target: tgt }));
};

describe('steps 1 to 3', () => {
  it.each(['source.dump', 'target.dump'] as const)('%s failure leaves the target untouched', async (method) => {
    const { fake, runner, callbacks } = setup({ failures: { [method]: new Error('nope') } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'untouched' });
    expect(fake.calls).not.toContain('target.dropDatabase');
    expect(await readJournal(paths, profile.id)).toBeNull();
    expect(await exists(paths.tmpDump(profile.id))).toBe(false);
  });

  it.each(['source.dump', 'target.dump'] as const)('cancel during %s leaves the target untouched', async (method) => {
    const ac = new AbortController();
    const { fake, runner, callbacks } = setup();
    fake.config.hooks[method] = () => { ac.abort(); };
    const out = await runner.sync(profile, callbacks(ac.signal));
    expect(out).toMatchObject({ status: 'cancelled', targetState: 'untouched' });
    expect(fake.calls).not.toContain('target.dropDatabase');
    expect(await readJournal(paths, profile.id)).toBeNull();
    expect(await exists(paths.tmpDump(profile.id))).toBe(false);
  });

  it('a failed backup keeps the previous backup', async () => {
    await writeBackup('old backup');
    const { runner, callbacks } = setup({ failures: { 'target.dump': new Error('disk full') } });
    await runner.sync(profile, callbacks());
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('old backup');
  });

  it('stops the download when output does not grow for the stall limit', async () => {
    const { fake, runner, callbacks } = setup({}, { stallLimitMs: 30, stallPollMs: 5 });
    const open = fake.adapter.openSource;
    fake.adapter.openSource = async (e) => {
      const src = await open(e);
      src.dump = async (dest, ctx) => {
        fake.calls.push('source.dump');
        await writeFile(dest, 'partial');
        await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('killed')), { once: true }));
      };
      return src;
    };
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'download', targetState: 'untouched' });
    expect(out.status === 'failed' && out.message).toContain('no new data');
    expect(fake.calls).toEqual(['source.dump']);
    expect(await exists(paths.tmpDump(profile.id))).toBe(false);
  });
});

describe('step 4 recovery', () => {
  it('restores the backup when restore fails', async () => {
    const { fake, runner, callbacks } = setup({ failuresOnce: { 'target.restore': new Error('boom') } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'replace', targetState: 'restored-from-backup', backupPath: paths.backupLatest(profile.id) });
    expect(fake.calls).toEqual([
      'source.dump', 'target.dump', 'target.dropDatabase', 'target.createDatabase', 'target.restore',
      'target.dropDatabase', 'target.createDatabase', 'target.restore',
    ]);
    expect(fake.created[1]).toEqual({ encoding: 'LATIN1' }); // the target's own options from meta.json
    expect(fake.restoredPaths[1]).toBe(paths.backupLatest(profile.id));
    expect(await readJournal(paths, profile.id)).toBeNull();
    expect(await exists(paths.backupLatest(profile.id))).toBe(true);
  });

  it('restores the backup when cancelled during restore, on a fresh signal', async () => {
    const ac = new AbortController();
    const { fake, runner, callbacks } = setup({ failuresOnce: { 'target.restore': new Error('aborted') } });
    fake.config.hooks['target.restore'] = () => { ac.abort(); };
    const aborted = watchSignals(fake);
    const out = await runner.sync(profile, callbacks(ac.signal));
    expect(out).toMatchObject({ status: 'cancelled', targetState: 'restored-from-backup' });
    expect(ac.signal.aborted).toBe(true);
    expect(aborted[1]).toBe(false);
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('removes the partial database when the target did not exist', async () => {
    const { fake, runner, callbacks } = setup({ targetExists: false, targetTables: [], failuresOnce: { 'target.restore': new Error('boom') } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'removed-partial' });
    expect(fake.calls).toEqual(['source.dump', 'target.createDatabase', 'target.restore', 'target.dropDatabase']);
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('reports maybe-incomplete when the backup was turned off, and keeps the journal', async () => {
    const { fake, runner, callbacks } = setup({ failuresOnce: { 'target.restore': new Error('boom') } });
    const out = await runner.sync({ ...profile, backupEnabled: false }, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'maybe-incomplete' });
    expect(fake.calls).toEqual(['source.dump', 'target.dropDatabase', 'target.createDatabase', 'target.restore']);
    expect(await readJournal(paths, profile.id)).not.toBeNull();
  });

  it('never auto-restores a stale backup from an earlier sync', async () => {
    await writeBackup('stale');
    const { fake, runner, callbacks } = setup({ failuresOnce: { 'target.restore': new Error('boom') } });
    const out = await runner.sync({ ...profile, backupEnabled: false }, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'maybe-incomplete' });
    expect(fake.calls.filter((c) => c === 'target.restore')).toHaveLength(1);
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('stale');
  });

  it('reports recovery-failed and keeps the file and journal when recovery fails', async () => {
    const { runner, callbacks } = setup({ failures: { 'target.restore': new Error('boom') } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'recovery-failed', backupPath: paths.backupLatest(profile.id) });
    expect(out.status === 'failed' && out.message).toContain(paths.backupLatest(profile.id));
    expect(await exists(paths.backupLatest(profile.id))).toBe(true);
    expect(await readJournal(paths, profile.id)).toMatchObject({ profileId: 'p1', hadTarget: true, backupAvailable: true });
  });

  it('checks the guard before recovery touches the target', async () => {
    let n = 0;
    const { fake, runner, callbacks } = setup(
      { failuresOnce: { 'target.restore': new Error('boom') } },
      { guard: () => ({ allowed: ++n < 3 } as GuardResult) },
    );
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'recovery-failed' });
    expect(fake.calls.filter((c) => c === 'target.dropDatabase')).toHaveLength(1);
    expect(await readJournal(paths, profile.id)).not.toBeNull();
  });

  it('writes the journal before the drop, with backupAvailable true only for a backup taken this run', async () => {
    await writeBackup('stale');
    const { fake, runner, callbacks } = setup();
    let seen: unknown;
    fake.config.hooks['target.dropDatabase'] = async () => { seen = await readJournal(paths, profile.id); };
    await runner.sync({ ...profile, backupEnabled: false }, callbacks());
    expect(seen).toMatchObject({ profileId: 'p1', hadTarget: true, backupAvailable: false });
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('stops before deleting when the drop is blocked', async () => {
    const { fake, runner, callbacks } = setup({ failures: { 'target.dropDatabase': new DropBlockedError(['psql', 'dbeaver']) } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'untouched' });
    expect(out.status === 'failed' && out.message).toContain('dbeaver');
    expect(await readJournal(paths, profile.id)).toBeNull();
    expect(fake.calls).not.toContain('target.createDatabase');
  });
});

describe('recover() and restoreBackup()', () => {
  it('recover() uses the journal after a simulated app close', async () => {
    const first = setup({ failures: { 'target.restore': new Error('x') } });
    await first.runner.sync(profile, first.callbacks()); // recovery fails, journal stays
    expect(await readJournal(paths, profile.id)).not.toBeNull();

    const second = setup(); // a new runner and adapter over the same paths
    const out = await second.runner.recover(profile, second.callbacks());
    expect(out).toMatchObject({ status: 'success', targetState: 'restored-from-backup' });
    expect(second.fake.calls).toEqual(['target.dropDatabase', 'target.createDatabase', 'target.restore']);
    expect(second.fake.created).toEqual([{ encoding: 'LATIN1' }]);
    expect(second.fake.restoredPaths).toEqual([paths.backupLatest(profile.id)]);
    expect(second.guardCalls).toEqual(['localhost']);
    expect(await readJournal(paths, profile.id)).toBeNull();
    expect(second.fake.closes).toEqual(['target']);
  });

  it('recover() runs on a fresh signal even when the caller already cancelled', async () => {
    await writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'x', target: tgt });
    await writeBackup();
    const ac = new AbortController();
    ac.abort();
    const { fake, runner, callbacks } = setup();
    const aborted = watchSignals(fake);
    expect(await runner.recover(profile, callbacks(ac.signal))).toMatchObject({ status: 'success' });
    expect(aborted).toEqual([false]);
  });

  it('recover() with backup off reports maybe-incomplete and keeps the journal', async () => {
    await writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: false, startedAt: 'x', target: tgt });
    const { fake, runner, callbacks } = setup();
    const out = await runner.recover(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'maybe-incomplete' });
    expect(fake.calls).toEqual([]);
    expect(fake.opens).toEqual([]);
    expect(await readJournal(paths, profile.id)).not.toBeNull();
  });

  it('recover() removes the partial database when the target did not exist', async () => {
    await writeJournal(paths, { profileId: 'p1', hadTarget: false, backupAvailable: false, startedAt: 'x', target: tgt });
    const { fake, runner, callbacks } = setup();
    expect(await runner.recover(profile, callbacks())).toMatchObject({ status: 'success', targetState: 'removed-partial' });
    expect(fake.calls).toEqual(['target.dropDatabase']);
  });

  it('recover() checks the guard before touching the target and keeps the journal when refused', async () => {
    await writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'x', target: tgt });
    await writeBackup();
    const { fake, runner, callbacks } = setup({}, { guard: () => ({ allowed: false, reason: 'not local' }) });
    const out = await runner.recover(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'recovery-failed', backupPath: paths.backupLatest(profile.id) });
    expect(fake.opens).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(await readJournal(paths, profile.id)).not.toBeNull();
  });

  it('recover() reports recovery-failed and keeps the journal when the restore fails', async () => {
    await writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'x', target: tgt });
    await writeBackup();
    const { runner, callbacks } = setup({ failures: { 'target.restore': new Error('bad') } });
    expect(await runner.recover(profile, callbacks())).toMatchObject({ status: 'failed', targetState: 'recovery-failed' });
    expect(await readJournal(paths, profile.id)).not.toBeNull();
  });

  it('recover() without a journal reports nothing to recover', async () => {
    const { fake, runner, callbacks } = setup();
    expect(await runner.recover(profile, callbacks())).toMatchObject({ status: 'failed', targetState: 'untouched' });
    expect(fake.opens).toEqual([]);
  });

  it('restoreBackup() replaces the target from latest, using the stored create options', async () => {
    await writeBackup('old backup', { encoding: 'WIN1252' });
    const { fake, runner, callbacks } = setup();
    const out = await runner.restoreBackup(profile, callbacks());
    expect(out).toMatchObject({ status: 'success', targetState: 'restored-from-backup' });
    expect(fake.calls).toEqual(['target.dropDatabase', 'target.createDatabase', 'target.restore']);
    expect(fake.created).toEqual([{ encoding: 'WIN1252' }]);
    expect(fake.restoredPaths).toEqual([paths.backupLatest(profile.id)]);
    expect(fake.opens).toEqual(['target']);
    expect(fake.closes).toEqual(['target']);
  });

  it('restoreBackup() checks the guard and keeps the backup afterwards', async () => {
    await writeBackup();
    const ok = setup();
    await ok.runner.restoreBackup(profile, ok.callbacks());
    expect(ok.guardCalls).toEqual(['localhost']);
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('old backup');
    expect(await exists(paths.backupMeta(profile.id))).toBe(true);

    const refused = setup({}, { guard: () => ({ allowed: false, reason: 'not local' }) });
    const out = await refused.runner.restoreBackup(profile, refused.callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'untouched' });
    expect(refused.fake.opens).toEqual([]);
    expect(refused.fake.calls).toEqual([]);
  });

  it('restoreBackup() without a backup fails untouched', async () => {
    const { fake, runner, callbacks } = setup();
    expect(await runner.restoreBackup(profile, callbacks())).toMatchObject({ status: 'failed', targetState: 'untouched' });
    expect(fake.calls).toEqual([]);
  });

  it('restoreBackup() leaves the target untouched when the drop is blocked', async () => {
    await writeBackup();
    const { runner, callbacks } = setup({ failures: { 'target.dropDatabase': new DropBlockedError(['psql']) } });
    const out = await runner.restoreBackup(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'untouched', backupPath: paths.backupLatest(profile.id) });
    expect(out.status === 'failed' && out.message).toContain('psql');
  });

  it('restoreBackup() reports maybe-incomplete and keeps the backup when the restore fails', async () => {
    await writeBackup();
    const { fake, runner, callbacks } = setup({ failures: { 'target.restore': new Error('bad') } });
    const out = await runner.restoreBackup(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'maybe-incomplete', backupPath: paths.backupLatest(profile.id) });
    expect(await exists(paths.backupLatest(profile.id))).toBe(true);
    expect(fake.closes).toEqual(['target']);
  });
});

describe('backup swap', () => {
  const dirDump = (fake: ReturnType<typeof createFakeAdapter>) => {
    const open = fake.adapter.openTarget;
    fake.adapter.openTarget = async (e) => {
      const t = await open(e);
      t.dump = async (dest) => {
        fake.calls.push('target.dump');
        await mkdir(join(dest, 'sub'), { recursive: true });
        await writeFile(join(dest, 'sub', 'file'), 'new dir backup');
      };
      return t;
    };
  };
  const writeDirBackup = async () => {
    await mkdir(join(paths.backupLatest(profile.id), 'sub'), { recursive: true });
    await writeFile(join(paths.backupLatest(profile.id), 'sub', 'file'), 'old dir backup');
  };
  const failRenameFrom = (from: string) => {
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (String(a) === from) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return realRename(a, b);
    });
  };

  it('swaps a directory backup in and removes the previous directory', async () => {
    await writeDirBackup();
    const { fake, runner, callbacks } = setup();
    dirDump(fake);
    expect((await runner.sync(profile, callbacks())).status).toBe('success');
    expect(await readFile(join(paths.backupLatest(profile.id), 'sub', 'file'), 'utf8')).toBe('new dir backup');
    expect(await exists(paths.backupPrevious(profile.id))).toBe(false);
    expect(await exists(paths.backupIncoming(profile.id))).toBe(false);
  });

  it('puts the previous backup back when moving the new one into place fails (directory)', async () => {
    await writeDirBackup();
    failRenameFrom(paths.backupIncoming(profile.id));
    const { fake, runner, callbacks } = setup();
    dirDump(fake);
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'backup', targetState: 'untouched' });
    expect(await readFile(join(paths.backupLatest(profile.id), 'sub', 'file'), 'utf8')).toBe('old dir backup');
    expect(await exists(paths.backupIncoming(profile.id))).toBe(false);
    expect(await exists(paths.backupPrevious(profile.id))).toBe(false);
    expect(fake.calls).not.toContain('target.dropDatabase');
  });

  it('puts the previous backup back when moving the new one into place fails (file)', async () => {
    await writeBackup('old backup');
    failRenameFrom(paths.backupIncoming(profile.id));
    const { runner, callbacks } = setup();
    expect(await runner.sync(profile, callbacks())).toMatchObject({ status: 'failed', step: 'backup' });
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('old backup');
  });

  it('writes meta.json through a temp file so it is never half-written', async () => {
    await writeBackup('old backup', { encoding: 'OLD' });
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (String(b) === paths.backupMeta(profile.id)) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return realRename(a, b);
    });
    const { runner, callbacks } = setup();
    expect(await runner.sync(profile, callbacks())).toMatchObject({ status: 'failed', step: 'backup' });
    expect(JSON.parse(await readFile(paths.backupMeta(profile.id), 'utf8')).createOptions).toEqual({ encoding: 'OLD' });
    expect((await readdir(paths.backupDir(profile.id))).sort()).toEqual(['latest', 'meta.json']);
  });
});

describe('describeFailure', () => {
  it('uses the version-mismatch copy when restore fails on an older target', () => {
    expect(describeFailure('replace', new ToolError(1, 'x'), pgInfo(17, null), pgInfo(15, null)).message)
      .toBe("Local PostgreSQL 15 can't load this dump from dev 17. Upgrade your local image.");
  });

  it('always names the step and a next action for each step', () => {
    const steps: SyncStep[] = ['check', 'download', 'backup', 'replace', 'verify'];
    const names = { check: /checks/i, download: /download/i, backup: /back/i, replace: /replac/i, verify: /check/i };
    for (const step of steps) {
      const { message } = describeFailure(step, new Error('boom'), pgInfo(16, null), pgInfo(16, null));
      expect(message).toMatch(names[step]);
      expect(message).toContain('boom');
      expect(message).toMatch(/try|check|run|free/i);
    }
  });

  it('keeps the tool output in the details', () => {
    const d = describeFailure('replace', new ToolError(1, 'line one\nrole "x" does not exist\n'), null, null);
    expect(d.message).toContain('role "x" does not exist');
    expect(d.details).toContain('line one');
  });
});

describe('fix round 1: a pending journal is honoured', () => {
  const pending = (over: object = {}) =>
    writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'old', target: tgt, ...over });
  const metaText = () => readFile(paths.backupMeta(profile.id), 'utf8');

  it('a re-sync that succeeds leaves latest and meta.json untouched and clears the journal', async () => {
    await writeBackup('good backup');
    await pending();
    const meta = await metaText();
    const { fake, runner, callbacks } = setup();
    let seen: unknown;
    fake.config.hooks['target.dropDatabase'] = async () => { seen = await readJournal(paths, profile.id); };
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'success', targetState: 'replaced' });
    expect(fake.calls).toEqual(['source.dump', 'target.dropDatabase', 'target.createDatabase', 'target.restore']);
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('good backup');
    expect(await metaText()).toBe(meta);
    expect(seen).toMatchObject({ hadTarget: true, backupAvailable: true });
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('a re-sync that fails recovers from the original latest', async () => {
    await writeBackup('good backup');
    await pending();
    const { fake, runner, callbacks } = setup({ failuresOnce: { 'target.restore': new Error('boom') } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'restored-from-backup', backupPath: paths.backupLatest(profile.id) });
    expect(fake.calls).not.toContain('target.dump');
    expect(fake.restoredPaths[1]).toBe(paths.backupLatest(profile.id));
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('good backup');
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('keeps the journal when the re-sync fails and recovery fails too', async () => {
    await writeBackup('good backup');
    await pending();
    const { runner, callbacks } = setup({ failures: { 'target.restore': new Error('boom') } });
    expect(await runner.sync(profile, callbacks())).toMatchObject({ targetState: 'recovery-failed' });
    expect(await readJournal(paths, profile.id)).toMatchObject({ hadTarget: true, backupAvailable: true });
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('good backup');
  });

  it('skips the backup and keeps the earlier flags when the earlier run had no backup', async () => {
    await writeBackup('good backup');
    await pending({ backupAvailable: false, hadTarget: false });
    const { fake, runner, callbacks } = setup({ failuresOnce: { 'target.restore': new Error('boom') } });
    const out = await runner.sync(profile, callbacks());
    expect(fake.calls).not.toContain('target.dump');
    expect(out).toMatchObject({ status: 'failed', targetState: 'removed-partial' });
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('good backup');
  });
});

describe('fix round 1: restoreBackup journal', () => {
  it('writes the journal before the drop and clears it on success', async () => {
    await writeBackup();
    const { fake, runner, callbacks } = setup();
    let seen: unknown;
    fake.config.hooks['target.dropDatabase'] = async () => { seen = await readJournal(paths, profile.id); };
    await runner.restoreBackup(profile, callbacks());
    expect(seen).toMatchObject({ profileId: 'p1', hadTarget: true, backupAvailable: true, target: tgt });
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('clears the journal when the drop is blocked', async () => {
    await writeBackup();
    const { runner, callbacks } = setup({ failures: { 'target.dropDatabase': new DropBlockedError(['psql']) } });
    await runner.restoreBackup(profile, callbacks());
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('keeps the journal on failure and cancel, and tells the user to run the restore again', async () => {
    await writeBackup();
    const fail = setup({ failures: { 'target.restore': new Error('bad') } });
    const out = await fail.runner.restoreBackup(profile, fail.callbacks());
    expect(out.status === 'failed' && out.message).toMatch(/restore again/i);
    expect(out.status === 'failed' && out.message).not.toMatch(/sync again/i);
    expect(await readJournal(paths, profile.id)).not.toBeNull();
    await rm(paths.journal(profile.id));

    const ac = new AbortController();
    const cancel = setup({ failures: { 'target.restore': new Error('aborted') } });
    cancel.fake.config.hooks['target.restore'] = () => { ac.abort(); };
    expect(await cancel.runner.restoreBackup(profile, cancel.callbacks(ac.signal))).toMatchObject({ status: 'cancelled' });
    expect(await readJournal(paths, profile.id)).not.toBeNull();
  });

  it('a successful restore clears an earlier journal left by recovery-failed', async () => {
    await writeBackup();
    const first = setup({ failures: { 'target.restore': new Error('x') } });
    expect(await first.runner.sync(profile, first.callbacks())).toMatchObject({ targetState: 'recovery-failed' });
    expect(await readJournal(paths, profile.id)).not.toBeNull();
    const second = setup();
    expect(await second.runner.restoreBackup(profile, second.callbacks())).toMatchObject({ status: 'success' });
    expect(await readJournal(paths, profile.id)).toBeNull();
  });
});

describe('fix round 1: the recorded target must match', () => {
  const other = { ...profile, target: { ...profile.target, port: 5433 } };
  const mismatch = "This profile's target changed after the last sync. Change it back to localhost:5432/app to recover your local data.";
  const noWork = (fake: ReturnType<typeof createFakeAdapter>) => {
    expect(fake.opens).toEqual([]);
    expect(fake.calls).toEqual([]);
  };

  it('recover() refuses', async () => {
    await writeBackup();
    await writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'x', target: tgt });
    const { fake, runner, callbacks } = setup();
    expect(await runner.recover(other, callbacks())).toMatchObject({ status: 'failed', targetState: 'untouched', message: mismatch });
    noWork(fake);
    expect(await readJournal(paths, profile.id)).not.toBeNull();
  });

  it('restoreBackup() refuses on a journal mismatch', async () => {
    await writeBackup();
    await writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'x', target: tgt });
    const { fake, runner, callbacks } = setup();
    expect(await runner.restoreBackup(other, callbacks())).toMatchObject({ status: 'failed', targetState: 'untouched', message: mismatch });
    noWork(fake);
  });

  it('restoreBackup() refuses on a meta mismatch', async () => {
    await writeBackup();
    const { fake, runner, callbacks } = setup();
    expect(await runner.restoreBackup(other, callbacks())).toMatchObject({
      status: 'failed', targetState: 'untouched',
      message: "The saved backup belongs to localhost:5432/app, not this profile's target. Change the target back to restore it.",
    });
    noWork(fake);
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('treats a missing target in old files as a mismatch', async () => {
    await mkdir(paths.backupDir(profile.id), { recursive: true });
    await writeFile(paths.backupLatest(profile.id), 'b');
    await writeFile(paths.backupMeta(profile.id), JSON.stringify({ createOptions: {}, takenAt: 1 }));
    const a = setup();
    expect(await a.runner.restoreBackup(profile, a.callbacks())).toMatchObject({ status: 'failed', targetState: 'untouched' });
    noWork(a.fake);
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(paths.journal(profile.id), JSON.stringify({ profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'x' }));
    const b = setup();
    expect(await b.runner.recover(profile, b.callbacks())).toMatchObject({ status: 'failed', targetState: 'untouched' });
    noWork(b.fake);
    const c = setup();
    expect(await c.runner.sync(profile, c.callbacks())).toMatchObject({ status: 'failed', targetState: 'untouched' });
    noWork(c.fake);
  });

  it('sync() refuses with a journal for another target, and proceeds without a journal', async () => {
    await writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'x', target: tgt });
    const a = setup();
    expect(await a.runner.sync(other, a.callbacks())).toMatchObject({ status: 'failed', targetState: 'untouched', message: mismatch });
    noWork(a.fake);
    await rm(paths.journal(profile.id));
    const b = setup();
    expect(await b.runner.sync(other, b.callbacks())).toMatchObject({ status: 'success' });
  });

  it('records the target in meta.json', async () => {
    const { runner, callbacks } = setup();
    await runner.sync(profile, callbacks());
    expect(JSON.parse(await readFile(paths.backupMeta(profile.id), 'utf8')).target).toEqual(tgt);
  });
});

describe('fix round 1: recovery-failed copy and info capture', () => {
  it('names the cause and the next action, with the backup path', async () => {
    const { runner, callbacks } = setup({ failures: { 'target.restore': new Error('server gone') } });
    const out = await runner.sync(profile, callbacks());
    expect(out.status === 'failed' && out.message).toBe(
      `Could not restore your previous local data: server gone. Close other programs using this database, check the local server is running, then choose Recover. Your backup is kept at ${paths.backupLatest(profile.id)}.`,
    );
  });

  it('says partial database, and not previous data, when there was no prior target', async () => {
    const { runner, callbacks } = setup({
      targetExists: false, targetTables: [],
      failuresOnce: { 'target.restore': new Error('boom') }, failures: { 'target.dropDatabase': new Error('locked') },
    });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ targetState: 'recovery-failed' });
    const msg = out.status === 'failed' ? out.message : '';
    expect(msg).toBe('Could not remove the partial local database: locked. Close other programs using this database, check the local server is running, then choose Recover.');
    expect(msg).not.toMatch(/previous local data/);
    expect(out.status === 'failed' && out.backupPath).toBeFalsy();
  });

  it('recover() uses the same copy', async () => {
    await writeBackup();
    await writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'x', target: tgt });
    const { runner, callbacks } = setup({ failures: { 'target.restore': new Error('bad') } });
    const out = await runner.recover(profile, callbacks());
    expect(out.status === 'failed' && out.message).toContain('Could not restore your previous local data: bad.');
  });

  it('words failures from the infos captured in step 1, without querying again', async () => {
    const { fake, runner, callbacks } = setup({
      sourceInfo: pgInfo(17, 's'), targetInfo: pgInfo(15, 't'),
      failuresOnce: { 'target.restore': new ToolError(1, 'x') },
    });
    fake.config.hooks['source.dump'] = () => {
      fake.config.sourceInfo = null as never; fake.config.targetInfo = null as never;
    };
    const out = await runner.sync(profile, callbacks());
    expect(out.status === 'failed' && out.message).toBe("Local PostgreSQL 15 can't load this dump from dev 17. Upgrade your local image.");
  });
});

describe('fix round 1: removals retry', () => {
  it('removes with recursive and retry options', async () => {
    const seen: unknown[] = [];
    const realRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, 'rm').mockImplementation(async (p, o) => { if (String(p) === paths.tmpDump(profile.id)) seen.push(o); return realRm(p, o); });
    const { runner, callbacks } = setup();
    await runner.sync(profile, callbacks());
    expect(seen[0]).toMatchObject({ recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('removes the journal with retry options', async () => {
    const seen: unknown[] = [];
    const realRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, 'rm').mockImplementation(async (p, o) => { if (String(p) === paths.journal(profile.id)) seen.push(o); return realRm(p, o); });
    const { runner, callbacks } = setup();
    await runner.sync(profile, callbacks());
    expect(seen[0]).toMatchObject({ force: true, maxRetries: 3, retryDelay: 100 });
  });
});

describe('fix round 2: the journal clears only when the target is known good', () => {
  const pending = (over: object = {}) =>
    writeJournal(paths, { profileId: 'p1', hadTarget: true, backupAvailable: true, startedAt: 'old', target: tgt, ...over });
  const latest = () => readFile(paths.backupLatest(profile.id), 'utf8');
  const journalText = () => readFile(paths.journal(profile.id), 'utf8');

  it.each([
    { hadTarget: true, backupAvailable: true },
    { hadTarget: true, backupAvailable: false },
    { hadTarget: false, backupAvailable: false },
  ])('a blocked drop on a re-sync keeps the journal and latest ($hadTarget, $backupAvailable)', async (flags) => {
    await writeBackup('good backup');
    await pending(flags);
    const a = setup({ failures: { 'target.dropDatabase': new DropBlockedError(['psql', 'dbeaver']) } });
    const out = await a.runner.sync(profile, a.callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'maybe-incomplete' });
    expect(out.status === 'failed' && out.message).toMatch(/may be incomplete/);
    expect(out.status === 'failed' && out.message).toContain('dbeaver');
    expect(await readJournal(paths, profile.id)).toMatchObject(flags);
    expect(await latest()).toBe('good backup');

    const b = setup();
    expect(await b.runner.sync(profile, b.callbacks())).toMatchObject({ status: 'success' });
    expect(b.fake.calls).not.toContain('target.dump');
    expect(await latest()).toBe('good backup');
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('a blocked drop with no earlier journal still ends untouched with no journal', async () => {
    const { runner, callbacks } = setup({ failures: { 'target.dropDatabase': new DropBlockedError(['psql']) } });
    expect(await runner.sync(profile, callbacks())).toMatchObject({ targetState: 'untouched' });
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('restoreBackup over an earlier journal plus a blocked drop restores the journal', async () => {
    await writeBackup('good backup');
    await pending({ backupAvailable: false });
    const before = await journalText();
    const { runner, callbacks } = setup({ failures: { 'target.dropDatabase': new DropBlockedError(['psql']) } });
    const out = await runner.restoreBackup(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'maybe-incomplete' });
    expect(await journalText()).toBe(before);
    expect(await latest()).toBe('good backup');
  });

  it('restoreBackup with no earlier journal plus a blocked drop leaves none and is untouched', async () => {
    await writeBackup('good backup');
    const { runner, callbacks } = setup({ failures: { 'target.dropDatabase': new DropBlockedError(['psql']) } });
    expect(await runner.restoreBackup(profile, callbacks())).toMatchObject({ targetState: 'untouched' });
    expect(await readJournal(paths, profile.id)).toBeNull();
  });

  it('a failed re-sync with backupAvailable false keeps the journal, and a later sync leaves latest alone', async () => {
    await writeBackup('good backup');
    await pending({ backupAvailable: false });
    const a = setup({ failuresOnce: { 'target.restore': new Error('boom') } });
    expect(await a.runner.sync(profile, a.callbacks())).toMatchObject({ status: 'failed', targetState: 'maybe-incomplete' });
    expect(await readJournal(paths, profile.id)).toMatchObject({ hadTarget: true, backupAvailable: false });
    const b = setup();
    expect(await b.runner.sync(profile, b.callbacks())).toMatchObject({ status: 'success' });
    expect(b.fake.calls).not.toContain('target.dump');
    expect(await latest()).toBe('good backup');
  });

  it('a re-sync cancelled during download leaves the journal and latest unchanged', async () => {
    await writeBackup('good backup');
    await pending();
    const before = await journalText();
    const ac = new AbortController();
    const { fake, runner, callbacks } = setup();
    fake.config.hooks['source.dump'] = () => { ac.abort(); };
    expect(await runner.sync(profile, callbacks(ac.signal))).toMatchObject({ status: 'cancelled', targetState: 'untouched' });
    expect(await journalText()).toBe(before);
    expect(await latest()).toBe('good backup');
  });

  it('a successful re-sync with backupAvailable false clears the journal and leaves latest', async () => {
    await writeBackup('good backup');
    await pending({ backupAvailable: false });
    const { runner, callbacks } = setup();
    expect(await runner.sync(profile, callbacks())).toMatchObject({ status: 'success' });
    expect(await readJournal(paths, profile.id)).toBeNull();
    expect(await latest()).toBe('good backup');
  });
});

describe('fix round 2: a damaged journal stops everything', () => {
  const expected = () =>
    `The recovery record at ${paths.journal(profile.id)} is damaged, so this was stopped to protect your backup in ${paths.backupDir(profile.id)}. Delete the record to continue.`;
  const damage = async () => {
    await writeBackup('good backup');
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(paths.journal(profile.id), '{"profileId": "p1", "hadTa');
  };

  it.each(['sync', 'recover', 'restoreBackup'] as const)('%s refuses with no connection', async (entry) => {
    await damage();
    const { fake, runner, callbacks } = setup();
    const out = await runner[entry](profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', targetState: 'maybe-incomplete', message: expected() });
    expect(fake.opens).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('good backup');
    expect(await exists(paths.journal(profile.id))).toBe(true);
  });
});
