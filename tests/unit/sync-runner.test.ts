import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fsp } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropBlockedError } from '../../src/main/engines/adapter';
import { createSyncPaths, type SyncPaths } from '../../src/main/sync/paths';
import { createSyncRunner, type RunCallbacks } from '../../src/main/sync/sync-runner';
import type { GuardResult } from '../../src/main/safety/target-guard';
import type { CheckIssue, Profile, SyncEvent } from '../../src/shared/types';
import { createFakeAdapter, type FakeConfig } from '../support/fake-adapter';

const profile: Profile = {
  id: 'p1', name: 'P', engine: 'postgres', backupEnabled: true,
  source: { host: 'dev.example.com', port: 5432, user: 'u', password: 'x', database: 'app', ssl: true },
  target: { host: 'localhost', port: 5432, user: 'u', password: 'x', database: 'app' },
};

let root: string;
let paths: SyncPaths;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'runner-')); paths = createSyncPaths(root); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const exists = (p: string) => stat(p).then(() => true, () => false);

function setup(overrides: Partial<FakeConfig> = {}, opts: { guard?: () => GuardResult; free?: number } = {}) {
  const fake = createFakeAdapter(overrides);
  const guardCalls: string[] = [];
  const runner = createSyncRunner({
    adapterFor: () => fake.adapter,
    paths,
    checkTarget: async (host) => { guardCalls.push(host); return opts.guard ? opts.guard() : { allowed: true }; },
    freeDiskBytes: async () => opts.free ?? 1_000_000,
    now: (() => { let t = 0; return () => (t += 10); })(),
  });
  const events: SyncEvent[] = [];
  const confirmed: CheckIssue[][] = [];
  const callbacks = (confirm = true): RunCallbacks => ({
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    confirmWarnings: async (issues) => { confirmed.push(issues); return confirm; },
  });
  return { fake, runner, events, confirmed, callbacks, guardCalls };
}

describe('sync runner', () => {
  it('stops with blocker target-not-local before opening any connection', async () => {
    const { fake, runner, callbacks } = setup({}, { guard: () => ({ allowed: false, reason: 'not local' }) });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'check', targetState: 'untouched' });
    expect(fake.opens).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('runs steps in order on success', async () => {
    const { fake, runner, callbacks } = setup();
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'success', targetState: 'replaced', warnings: [] });
    expect(fake.calls).toEqual(['source.dump', 'target.dump', 'target.dropDatabase', 'target.createDatabase', 'target.restore']);
  });

  it('emits step events check, download, backup, replace, verify', async () => {
    const { events, runner, callbacks } = setup();
    await runner.sync(profile, callbacks());
    expect(events.filter((e) => e.type === 'step').map((e) => e.step))
      .toEqual(['check', 'download', 'backup', 'replace', 'verify']);
  });

  it('forwards step progress and log lines as events', async () => {
    const { fake, events, runner, callbacks } = setup();
    const original = fake.adapter.openSource;
    fake.adapter.openSource = async (e) => {
      const src = await original(e);
      const dump = src.dump;
      src.dump = async (dest, ctx) => { ctx.onLog('hello'); ctx.onProgress('Downloading', 50); await dump(dest, ctx); };
      return src;
    };
    await runner.sync(profile, callbacks());
    expect(events).toContainEqual({ type: 'log', line: 'hello' });
    expect(events).toContainEqual({ type: 'progress', label: 'Downloading', percent: 50 });
  });

  it('skips the backup when backupEnabled is false', async () => {
    const { fake, events, runner, callbacks } = setup();
    const out = await runner.sync({ ...profile, backupEnabled: false }, callbacks());
    expect(out.status).toBe('success');
    expect(fake.calls).toEqual(['source.dump', 'target.dropDatabase', 'target.createDatabase', 'target.restore']);
    expect(events.some((e) => e.type === 'step' && e.step === 'backup')).toBe(false);
    expect(await exists(paths.backupDir(profile.id))).toBe(false);
  });

  it('skips the backup and the drop when the target does not exist', async () => {
    const { fake, runner, callbacks, guardCalls } = setup({ targetExists: false, targetTables: [] });
    const out = await runner.sync(profile, callbacks());
    expect(guardCalls).toHaveLength(2);
    expect(out).toMatchObject({ status: 'success', targetState: 'replaced' });
    expect(fake.calls).toEqual(['source.dump', 'target.createDatabase', 'target.restore']);
  });

  it('succeeds with an empty source', async () => {
    const { runner, callbacks } = setup({ sourceTables: [], targetTables: [] });
    expect(await runner.sync(profile, callbacks())).toMatchObject({ status: 'success', warnings: [] });
  });

  it('stops on a blocker with targetState untouched and no dump', async () => {
    const { fake, runner, callbacks, confirmed } = setup({ canCreate: false });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'check', targetState: 'untouched' });
    expect(out.status === 'failed' && out.details).toContain('cannot-create-db');
    expect(fake.calls).toEqual([]);
    expect(confirmed).toEqual([]);
    expect(fake.closes.sort()).toEqual(['source', 'target']);
  });

  it('continues past warnings only when confirmWarnings resolves true', async () => {
    const lowDisk = { free: 10 };
    const yes = setup({}, lowDisk);
    const ok = await yes.runner.sync(profile, yes.callbacks(true));
    expect(ok).toMatchObject({ status: 'success' });
    expect(ok.status === 'success' && ok.warnings.map((w) => w.code)).toEqual(['low-disk']);
    expect(yes.confirmed[0].map((i) => i.code)).toEqual(['low-disk']);

    const no = setup({}, lowDisk);
    expect(await no.runner.sync(profile, no.callbacks(false))).toEqual({ status: 'cancelled', targetState: 'untouched' });
    expect(no.fake.calls).toEqual([]);
  });

  it('does not ask for confirmation when there are no warnings', async () => {
    const { runner, callbacks, confirmed } = setup();
    await runner.sync(profile, callbacks());
    expect(confirmed).toEqual([]);
  });

  it('checks the target guard again immediately before the drop', async () => {
    let n = 0;
    const { fake, runner, callbacks, guardCalls } = setup({}, { guard: () => ({ allowed: ++n < 2 } as GuardResult) });
    const out = await runner.sync(profile, callbacks());
    expect(guardCalls).toEqual(['localhost', 'localhost']);
    expect(out).toMatchObject({ status: 'failed', step: 'replace', targetState: 'untouched' });
    expect(fake.calls).not.toContain('target.dropDatabase');
    expect(fake.calls).toEqual(['source.dump', 'target.dump']);
  });

  it('reports a table list difference as a warning, not a failure', async () => {
    const { runner, callbacks } = setup({ sourceTables: ['public.a', 'public.b', 'public.c'] });
    const out = await runner.sync(profile, callbacks());
    expect(out.status).toBe('success');
    expect(out.status === 'success' && out.warnings).toEqual([{
      severity: 'warning', code: 'tables-differ',
      message: 'Local tables differ from dev. Dev may have changed after the copy started.',
    }]);
  });

  it('swaps the new backup in only after it completes', async () => {
    await mkdir(paths.backupDir(profile.id), { recursive: true });
    await writeFile(paths.backupLatest(profile.id), 'old backup');
    const seenDuringBackup: Record<string, boolean | string> = {};
    const { fake, runner, callbacks } = setup();
    fake.config.hooks['target.dump'] = async () => {
      seenDuringBackup.latest = await readFile(paths.backupLatest(profile.id), 'utf8');
    };
    const out = await runner.sync(profile, callbacks());
    expect(out.status).toBe('success');
    expect(seenDuringBackup.latest).toBe('old backup');
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('target.dump');
    expect(await exists(paths.backupIncoming(profile.id))).toBe(false);
    expect(await exists(paths.backupPrevious(profile.id))).toBe(false);
    const meta = JSON.parse(await readFile(paths.backupMeta(profile.id), 'utf8'));
    expect(meta.createOptions).toEqual({ encoding: 'LATIN1' });
    expect(typeof meta.takenAt).toBe('number');
  });

  it('keeps the previous backup when the new one fails', async () => {
    await mkdir(paths.backupDir(profile.id), { recursive: true });
    await writeFile(paths.backupLatest(profile.id), 'old backup');
    const { fake, runner, callbacks } = setup({ failures: { 'target.dump': new Error('disk full') } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'backup', targetState: 'untouched' });
    expect(await readFile(paths.backupLatest(profile.id), 'utf8')).toBe('old backup');
    expect(await exists(paths.backupIncoming(profile.id))).toBe(false);
    expect(fake.calls).not.toContain('target.dropDatabase');
  });

  it('removes the tmp dump on success and on failure', async () => {
    const ok = setup();
    await ok.runner.sync(profile, ok.callbacks());
    expect(await exists(paths.tmpDump(profile.id))).toBe(false);

    const bad = setup({ failuresOnce: { 'target.restore': new Error('boom') } });
    const out = await bad.runner.sync(profile, bad.callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'replace', message: expect.stringContaining('boom') });
    expect(await exists(paths.tmpDump(profile.id))).toBe(false);
    expect(await readdir(paths.tmpRoot)).toEqual([]);
  });

  it('reports a failure after the drop as maybe-incomplete when recovery has no backup', async () => {
    const { runner, callbacks } = setup({ failuresOnce: { 'target.createDatabase': new Error('boom') } });
    expect(await runner.sync({ ...profile, backupEnabled: false }, callbacks())).toMatchObject({ status: 'failed', step: 'replace', targetState: 'maybe-incomplete' });
  });

  it('removes the partial database after a failed first-sync create', async () => {
    const { runner, callbacks } = setup({ targetExists: false, targetTables: [], failuresOnce: { 'target.createDatabase': new Error('x') } });
    expect(await runner.sync(profile, callbacks())).toMatchObject({ status: 'failed', targetState: 'removed-partial' });
  });

  it('reports an unexpected drop error as maybe-incomplete when recovery has no backup', async () => {
    const { runner, callbacks } = setup({ failuresOnce: { 'target.dropDatabase': new Error('connection lost') } });
    expect(await runner.sync({ ...profile, backupEnabled: false }, callbacks())).toMatchObject({
      status: 'failed', step: 'replace', message: expect.stringContaining('connection lost'), targetState: 'maybe-incomplete',
    });
  });

  it('does not call the drop when cancelled right after the second guard check', async () => {
    const ac = new AbortController();
    let n = 0;
    const { fake, runner, events } = setup({}, { guard: () => { if (++n === 2) ac.abort(); return { allowed: true }; } });
    const out = await runner.sync(profile, { signal: ac.signal, onEvent: (e) => events.push(e), confirmWarnings: async () => true });
    expect(out).toMatchObject({ status: 'cancelled', targetState: 'untouched' });
    expect(fake.calls).not.toContain('target.dropDatabase');
  });

  it('still returns the outcome and closes both connections when removing the tmp dump fails', async () => {
    const realRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, 'rm').mockImplementation(async (path, opts) => {
      if (String(path) === paths.tmpDump(profile.id)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return realRm(path, opts);
    });
    const { fake, runner, events, callbacks } = setup({ failuresOnce: { 'target.restore': new Error('real error') } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'replace', message: expect.stringContaining('real error') });
    expect(fake.closes.sort()).toEqual(['source', 'target']);
    expect(events.some((e) => e.type === 'log' && e.line.includes('busy'))).toBe(true);
  });

  it('still returns the outcome and closes the other connection when close() rejects', async () => {
    const { fake, runner, callbacks } = setup();
    const openSource = fake.adapter.openSource;
    fake.adapter.openSource = async (e) => {
      const src = await openSource(e);
      const close = src.close;
      src.close = async () => { await close(); throw new Error('close failed'); };
      return src;
    };
    expect(await runner.sync(profile, callbacks())).toMatchObject({ status: 'success' });
    expect(fake.closes.sort()).toEqual(['source', 'target']);
  });

  it('finishes as success with a warning when reading tables fails during verify', async () => {
    const { fake, runner, callbacks } = setup();
    const openTarget = fake.adapter.openTarget;
    fake.adapter.openTarget = async (e) => {
      const t = await openTarget(e);
      const list = t.listTables;
      t.listTables = async () => {
        if (fake.calls.includes('target.restore')) throw new Error('read failed');
        return list();
      };
      return t;
    };
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'success', targetState: 'replaced' });
    expect(out.status === 'success' && out.warnings).toEqual([{
      severity: 'warning', code: 'verify-failed',
      message: 'Could not compare tables with dev. The local copy was restored but not checked.',
    }]);
  });

  it('finishes as success when cancelled after the restore completed', async () => {
    const ac = new AbortController();
    const { fake, runner, events } = setup();
    fake.config.hooks['target.restore'] = () => { ac.abort(); };
    const out = await runner.sync(profile, { signal: ac.signal, onEvent: (e) => events.push(e), confirmWarnings: async () => true });
    expect(out).toMatchObject({ status: 'success', targetState: 'replaced' });
  });

  it('reports a blocked drop as untouched and names the clients', async () => {
    const { runner, callbacks } = setup({ failures: { 'target.dropDatabase': new DropBlockedError(['psql', 'dbeaver']) } });
    const out = await runner.sync(profile, callbacks());
    expect(out).toMatchObject({ status: 'failed', step: 'replace', targetState: 'untouched' });
    expect(out.status === 'failed' && out.details).toContain('dbeaver');
  });

  it('fails the download step without touching the target', async () => {
    const { fake, runner, callbacks } = setup({ failures: { 'source.dump': new Error('network') } });
    expect(await runner.sync(profile, callbacks())).toMatchObject({ status: 'failed', step: 'download', targetState: 'untouched' });
    expect(fake.calls).toEqual(['source.dump']);
  });

  it('returns cancelled when the signal is aborted during the download', async () => {
    const { fake, runner, events } = setup();
    const ac = new AbortController();
    fake.config.hooks['source.dump'] = () => { ac.abort(); };
    const out = await runner.sync(profile, { signal: ac.signal, onEvent: (e) => events.push(e), confirmWarnings: async () => true });
    expect(out).toEqual({ status: 'cancelled', targetState: 'untouched' });
    expect(fake.calls).toEqual(['source.dump']);
    expect(await exists(paths.tmpDump(profile.id))).toBe(false);
  });

  it('creates the target with the source create options', async () => {
    const { fake, runner, callbacks } = setup();
    await runner.sync(profile, callbacks());
    expect(fake.created).toEqual([{ encoding: 'UTF8', collation: 'en_US' }]);
  });

  it('closes both connections in every path', async () => {
    for (const overrides of [{}, { canCreate: false }, { failures: { 'source.dump': new Error('x') } }] as Partial<FakeConfig>[]) {
      const { fake, runner, callbacks } = setup(overrides);
      await runner.sync(profile, callbacks());
      expect(fake.closes.sort()).toEqual(['source', 'target']);
    }
  });

});
