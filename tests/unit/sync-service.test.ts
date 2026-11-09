import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as realFs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAdapter } from '../../src/main/engines/adapter';
import { createProfileStore, type Cipher, type ProfileStore } from '../../src/main/profiles/profile-store';
import { checkTargetHost } from '../../src/main/safety/target-guard';
import { createSyncPaths, type SyncPaths } from '../../src/main/sync/paths';
import { createSyncRunner } from '../../src/main/sync/sync-runner';
import { createLogStore } from '../../src/main/sync/sync-log';
import { createSyncService, type SyncRunner } from '../../src/main/sync/sync-service';
import { SyncBusyError } from '../../src/shared/api';
import type { CheckIssue, ProfileInput, SyncEvent, SyncOutcome } from '../../src/shared/types';
import { createFakeAdapter, type FakeConfig } from '../support/fake-adapter';

const SOURCE_PW = 'src-secret-Q7';
const TARGET_PW = 'tgt-secret-Z9';

const cipher = (over: Partial<Cipher> = {}): Cipher => ({
  isAvailable: () => true,
  encrypt: (p) => `enc:${Buffer.from(p).toString('base64')}`,
  decrypt: (s) => Buffer.from(s.replace(/^enc:/, ''), 'base64').toString(),
  ...over,
});
/** Fails to decrypt the one password that was saved as `lost`. */
const lossyCipher = (): Cipher => cipher({
  decrypt: (s) => {
    const p = Buffer.from(s.replace(/^enc:/, ''), 'base64').toString();
    if (p === 'lost') throw new Error('cannot decrypt');
    return p;
  },
});
const input = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  name: 'Orders', engine: 'postgres', backupEnabled: true,
  source: { host: 'dev.example.com', port: 5432, user: 'ro', password: SOURCE_PW, database: 'orders', ssl: true },
  target: { host: 'localhost', port: 5433, user: 'me', password: TARGET_PW, database: 'orders' },
  ...over,
});
const exists = (p: string) => stat(p).then(() => true, () => false);
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5));
};

let root: string;
let paths: SyncPaths;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sync-service-')); paths = createSyncPaths(root); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

interface Rig {
  store: ProfileStore;
  service: ReturnType<typeof createSyncService>;
  fake: ReturnType<typeof createFakeAdapter>;
  events: Array<[string, SyncEvent]>;
  warnings: Array<[string, CheckIssue[]]>;
  openedWith: Array<{ side: string; password: string }>;
}
function rig(opts: { fake?: Partial<FakeConfig>; runner?: SyncRunner; cipher?: Cipher } = {}): Rig {
  const store = createProfileStore(paths.profilesFile, opts.cipher ?? cipher());
  const fake = createFakeAdapter(opts.fake);
  const openedWith: Rig['openedWith'] = [];
  const adapter: EngineAdapter = {
    ...fake.adapter,
    openSource: async (e) => { openedWith.push({ side: 'source', password: e.password }); return fake.adapter.openSource(e); },
    openTarget: async (e) => { openedWith.push({ side: 'target', password: e.password }); return fake.adapter.openTarget(e); },
  };
  const checkTarget = (host: string) => checkTargetHost(host, async () => ['127.0.0.1']);
  const runner = opts.runner ?? createSyncRunner({
    adapterFor: () => adapter, paths, checkTarget, freeDiskBytes: async () => 1e9,
  });
  const events: Rig['events'] = [];
  const warnings: Rig['warnings'] = [];
  const service = createSyncService({
    store, runner, paths, logs: createLogStore(paths), adapterFor: () => adapter, checkTarget,
    onEvent: (id, e) => events.push([id, e]),
    onWarnings: (id, issues) => warnings.push([id, issues]),
  });
  return { store, service, fake, events, warnings, openedWith };
}
const stubRunner = (over: Partial<SyncRunner> = {}): SyncRunner => {
  const ok = async (): Promise<SyncOutcome> => ({ status: 'success', durationMs: 1, warnings: [], targetState: 'replaced' });
  return { sync: ok, restoreBackup: ok, recover: ok, ...over };
};
const cancelled = async (): Promise<SyncOutcome> => ({ status: 'cancelled', targetState: 'untouched' });
const logTexts = async (id: string) => {
  const dir = paths.logsDir(id);
  const files = (await readdir(dir)).sort();
  return Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')));
};

describe('single run lock', () => {
  it('rejects a second run with SyncBusyError across profiles', async () => {
    const g = gate();
    const r = rig({ runner: stubRunner({ sync: async () => { await g.promise; return cancelled(); } }) });
    const a = (await r.service.saveProfile(input({ name: 'A' }))).id;
    const b = (await r.service.saveProfile(input({ name: 'B' }))).id;
    const first = r.service.startSync(a);
    await expect(r.service.startSync(b)).rejects.toBeInstanceOf(SyncBusyError);
    await expect(r.service.startSync(a)).rejects.toBeInstanceOf(SyncBusyError);
    g.open();
    await first;
  });

  it('allows a new run after the previous finishes or fails', async () => {
    let n = 0;
    const r = rig({
      runner: stubRunner({
        sync: async () => {
          n += 1;
          if (n === 2) throw new Error('boom');
          return { status: 'success', durationMs: 1, warnings: [], targetState: 'replaced' };
        },
      }),
    });
    const id = (await r.service.saveProfile(input())).id;
    await r.service.startSync(id);
    await expect(r.service.startSync(id)).rejects.toThrow('boom');
    expect((await r.service.startSync(id)).status).toBe('success');
    expect(r.service.hasRunningSync()).toBe(false);
  });

  it('restoreBackup and recover take the same lock', async () => {
    const g1 = gate();
    const g2 = gate();
    const r = rig({
      runner: stubRunner({
        restoreBackup: async () => { await g1.promise; return cancelled(); },
        recover: async () => { await g2.promise; return cancelled(); },
      }),
    });
    const id = (await r.service.saveProfile(input())).id;
    const restoring = r.service.restoreBackup(id);
    await expect(r.service.recover(id)).rejects.toBeInstanceOf(SyncBusyError);
    await expect(r.service.startSync(id)).rejects.toBeInstanceOf(SyncBusyError);
    g1.open();
    await restoring;
    const recovering = r.service.recover(id);
    await expect(r.service.restoreBackup(id)).rejects.toBeInstanceOf(SyncBusyError);
    await expect(r.service.startSync(id)).rejects.toBeInstanceOf(SyncBusyError);
    g2.open();
    await recovering;
  });

  it('hasRunningSync is true only during a run', async () => {
    const g = gate();
    const r = rig({ runner: stubRunner({ sync: async () => { await g.promise; return cancelled(); } }) });
    const id = (await r.service.saveProfile(input())).id;
    expect(r.service.hasRunningSync()).toBe(false);
    const run = r.service.startSync(id);
    await until(() => r.service.hasRunningSync());
    expect(r.service.hasRunningSync()).toBe(true);
    g.open();
    await run;
    expect(r.service.hasRunningSync()).toBe(false);
  });

  it('refuses to delete a profile while it is syncing', async () => {
    const g = gate();
    const r = rig({ runner: stubRunner({ sync: async () => { await g.promise; return cancelled(); } }) });
    const id = (await r.service.saveProfile(input())).id;
    const run = r.service.startSync(id);
    await expect(r.service.deleteProfile(id)).rejects.toThrow(/running sync/i);
    g.open();
    await run;
    await r.service.deleteProfile(id);
  });
});

describe('warnings and cancel', () => {
  const warning: CheckIssue = { severity: 'warning', code: 'w', message: 'Heads up' };

  it('passes warnings to the UI and resolves from answerWarnings', async () => {
    const r = rig({ fake: { engineIssues: [warning] } });
    const id = (await r.service.saveProfile(input())).id;
    const run = r.service.startSync(id);
    await until(() => r.warnings.length > 0);
    expect(r.warnings[0][0]).toBe(id);
    expect(r.warnings[0][1].map((i) => i.code)).toContain('w');
    await r.service.answerWarnings(true);
    const outcome = await run;
    expect(outcome.status).toBe('success');
    expect(r.fake.calls).toContain('target.restore');
  });

  it('a refused warning cancels the run without touching the target', async () => {
    const r = rig({ fake: { engineIssues: [warning] } });
    const id = (await r.service.saveProfile(input())).id;
    const run = r.service.startSync(id);
    await until(() => r.warnings.length > 0);
    await r.service.answerWarnings(false);
    expect(await run).toEqual({ status: 'cancelled', targetState: 'untouched' });
    expect(r.fake.calls).toEqual([]);
  });

  it('cancel aborts the current run', async () => {
    const g = gate();
    const r = rig({ fake: { hooks: { 'source.dump': () => g.promise } } });
    const id = (await r.service.saveProfile(input())).id;
    const run = r.service.startSync(id);
    await until(() => r.fake.calls.includes('source.dump'));
    await r.service.cancel();
    g.open();
    expect(await run).toMatchObject({ status: 'cancelled', targetState: 'untouched' });
    expect(r.fake.calls).not.toContain('target.dropDatabase');
  });

  it('cancel while a warning is waiting ends the run as cancelled', async () => {
    const r = rig({ fake: { engineIssues: [warning] } });
    const id = (await r.service.saveProfile(input())).id;
    const run = r.service.startSync(id);
    await until(() => r.warnings.length > 0);
    await r.service.cancel();
    expect(await run).toMatchObject({ status: 'cancelled', targetState: 'untouched' });
  });

  it('cancel and answerWarnings do nothing when no run is active', async () => {
    const r = rig();
    await expect(r.service.cancel()).resolves.toBeUndefined();
    await expect(r.service.answerWarnings(true)).resolves.toBeUndefined();
  });
});

describe('shutdown', () => {
  it('cancels and waits for the automatic recovery before it resolves', async () => {
    const g = gate();
    let restores = 0;
    const r = rig({
      fake: {
        hooks: {
          'target.restore': async () => {
            restores += 1;
            if (restores === 1) { await g.promise; throw new Error('interrupted'); } // the recovery restore (2nd) succeeds
          },
        },
      },
    });
    const id = (await r.service.saveProfile(input())).id;
    const run = r.service.startSync(id);
    await until(() => restores === 1);
    let shutDown = false;
    const closing = r.service.shutdown().then(() => { shutDown = true; });
    await new Promise((res) => setTimeout(res, 30));
    expect(shutDown).toBe(false);
    g.open();
    await closing;
    expect(restores).toBe(2); // the backup was restored before shutdown finished
    expect(await run).toMatchObject({ status: 'cancelled', targetState: 'restored-from-backup' });
    expect(r.service.hasRunningSync()).toBe(false);
    expect((await r.service.listProfiles())[0].lastResult).toMatchObject({ targetState: 'restored-from-backup' });
  });

  it('refuses new runs once shutting down, and resolves at once when idle', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    await r.service.shutdown();
    await expect(r.service.startSync(id)).rejects.toThrow(/closing/i);
  });
});

describe('results and views', () => {
  it('saves the outcome as lastResult', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    const outcome = await r.service.startSync(id);
    expect(outcome.status).toBe('success');
    expect(await r.store.lastResult(id)).toEqual(outcome);
    expect((await r.service.listProfiles())[0].lastResult).toEqual(outcome);
  });

  it('views report hasUnfinishedSync from the journal and hasBackup from the backup folder', async () => {
    const r = rig();
    const a = (await r.service.saveProfile(input({ name: 'A' }))).id;
    const b = (await r.service.saveProfile(input({ name: 'B' }))).id;
    let views = await r.service.listProfiles();
    expect(views.map((v) => [v.hasBackup, v.hasUnfinishedSync])).toEqual([[false, false], [false, false]]);
    await mkdir(paths.backupLatest(a), { recursive: true });
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(paths.journal(b), JSON.stringify({
      profileId: b, hadTarget: true, backupAvailable: false, startedAt: 'x',
      target: { host: 'localhost', port: 5433, database: 'orders' },
    }));
    views = await r.service.listProfiles();
    expect(views.find((v) => v.id === a)).toMatchObject({ hasBackup: true, hasUnfinishedSync: false });
    expect(views.find((v) => v.id === b)).toMatchObject({ hasBackup: false, hasUnfinishedSync: true });
  });

  it('a damaged journal counts as unfinished and does not fail the list', async () => {
    const r = rig();
    const a = (await r.service.saveProfile(input({ name: 'A' }))).id;
    await r.service.saveProfile(input({ name: 'B' }));
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(paths.journal(a), '{ half a jou');
    const views = await r.service.listProfiles();
    expect(views).toHaveLength(2);
    expect(views.find((v) => v.id === a)?.hasUnfinishedSync).toBe(true);
    expect(views.find((v) => v.id !== a)?.hasUnfinishedSync).toBe(false);
  });

  it('lists every profile when one password is unreadable, and that run fails at Check', async () => {
    const plain = rig();
    const bad = (await plain.service.saveProfile(input({ name: 'Bad', target: { ...input().target, password: 'lost' } }))).id;
    await plain.service.saveProfile(input({ name: 'Good' }));
    const r = rig({ cipher: lossyCipher() });
    const views = await r.service.listProfiles();
    expect(views).toHaveLength(2);
    const v = views.find((x) => x.id === bad)!;
    expect(v.target.passwordUnreadable).toBe(true);
    expect(v.source.passwordUnreadable).toBe(false);
    expect(views.find((x) => x.id !== bad)!.target.passwordUnreadable).toBe(false);
    const outcome = await r.service.startSync(bad);
    expect(outcome).toMatchObject({ status: 'failed', step: 'check', targetState: 'untouched' });
    expect((outcome as { message: string }).message).toMatch(/enter it again/i);
    expect(r.openedWith).toEqual([]);
    expect(r.fake.calls).toEqual([]);
    expect(await r.store.lastResult(bad)).toEqual(outcome);
  });

  it('a corrupt profiles.json fails with the file name and is left alone', async () => {
    await writeFile(paths.profilesFile, 'garbage', 'utf8');
    const r = rig();
    await expect(r.service.listProfiles()).rejects.toThrow(paths.profilesFile);
    await expect(r.service.saveProfile(input())).rejects.toThrow(paths.profilesFile);
    expect(await readFile(paths.profilesFile, 'utf8')).toBe('garbage');
  });
});

describe('startup', () => {
  it('removes leftover tmp files, including defaults files that hold a password', async () => {
    const r = rig();
    await mkdir(join(paths.tmpRoot, 'nested.dump'), { recursive: true });
    await writeFile(join(paths.tmpRoot, 'nested.dump', 'toc.dat'), 'x');
    await writeFile(join(paths.tmpRoot, 'p1.dump'), 'x');
    await writeFile(join(paths.tmpRoot, 'client-0123456789abcdef.cnf'), `[client]\npassword="${TARGET_PW}"\n`);
    await r.service.startup();
    expect(await readdir(paths.tmpRoot).catch(() => [])).toEqual([]);
    expect(await exists(join(paths.tmpRoot, 'client-0123456789abcdef.cnf'))).toBe(false);
  });

  it('keeps backups and journals', async () => {
    const r = rig();
    await mkdir(paths.backupLatest('p1'), { recursive: true });
    await writeFile(paths.backupMeta('p1'), '{}');
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(paths.journal('p1'), '{}');
    await mkdir(paths.logsDir('p1'), { recursive: true });
    await writeFile(join(paths.logsDir('p1'), 'a.log'), 'x');
    await mkdir(paths.tmpRoot, { recursive: true });
    await writeFile(join(paths.tmpRoot, 'p1.dump'), 'x');
    await r.service.startup();
    expect(await exists(paths.backupLatest('p1'))).toBe(true);
    expect(await exists(paths.backupMeta('p1'))).toBe(true);
    expect(await exists(paths.journal('p1'))).toBe(true);
    expect(await exists(join(paths.logsDir('p1'), 'a.log'))).toBe(true);
    expect(await exists(join(paths.tmpRoot, 'p1.dump'))).toBe(false);
  });

  it('works when there is no tmp folder yet', async () => {
    await expect(rig().service.startup()).resolves.toEqual([]);
  });
});

describe('startup repairs', () => {
  it('removes each client-*.cnf on its own, so one locked file does not stop the others, and reports it', async () => {
    const r = rig();
    await mkdir(paths.tmpRoot, { recursive: true });
    const locked = join(paths.tmpRoot, 'client-locked.cnf');
    await writeFile(locked, 'password=x');
    await writeFile(join(paths.tmpRoot, 'client-other.cnf'), 'password=y');
    await writeFile(join(paths.tmpRoot, 'p1.dump'), 'x');
    const realRm = realFs.rm.bind(realFs);
    vi.spyOn(realFs, 'rm').mockImplementation(async (path, opts) => {
      if (String(path) === locked) throw new Error('EBUSY');
      return realRm(path, opts);
    });
    const problems = await r.service.startup();
    expect(problems.join(' ')).toContain(locked);
    expect(await exists(join(paths.tmpRoot, 'client-other.cnf'))).toBe(false);
    expect(await exists(join(paths.tmpRoot, 'p1.dump'))).toBe(false);
  });

  it('removes backups/*/incoming', async () => {
    const r = rig();
    await mkdir(paths.backupIncoming('p1'), { recursive: true });
    await mkdir(paths.backupLatest('p1'), { recursive: true });
    await r.service.startup();
    expect(await exists(paths.backupIncoming('p1'))).toBe(false);
    expect(await exists(paths.backupLatest('p1'))).toBe(true);
  });

  it('puts previous back as latest when a crash mid-swap left no latest', async () => {
    const r = rig();
    await mkdir(paths.backupPrevious('p1'), { recursive: true });
    await writeFile(join(paths.backupPrevious('p1'), 'good'), 'data');
    await r.service.startup();
    expect(await exists(paths.backupPrevious('p1'))).toBe(false);
    expect(await readFile(join(paths.backupLatest('p1'), 'good'), 'utf8')).toBe('data');
  });

  it('leaves previous alone when latest exists, and survives a missing backups folder', async () => {
    const r = rig();
    await expect(r.service.startup()).resolves.toEqual([]);
    await mkdir(paths.backupPrevious('p1'), { recursive: true });
    await mkdir(paths.backupLatest('p1'), { recursive: true });
    await r.service.startup();
    expect(await exists(paths.backupPrevious('p1'))).toBe(true);
    expect(await exists(paths.backupLatest('p1'))).toBe(true);
  });

  it('never throws, even when the tmp folder cannot be removed', async () => {
    const r = rig();
    await mkdir(paths.tmpRoot, { recursive: true });
    vi.spyOn(realFs, 'rm').mockRejectedValue(new Error('EPERM'));
    const problems = await r.service.startup();
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('closing', () => {
  it('markClosing refuses new runs without cancelling anything', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    r.service.markClosing();
    await expect(r.service.startSync(id)).rejects.toThrow(/closing/i);
    await expect(r.service.recover(id)).rejects.toThrow(/closing/i);
  });
});

describe('profiles', () => {
  const pendingJournal = (id: string, target = { host: 'localhost', port: 5433, database: 'orders' }) =>
    mkdir(join(root, 'journal'), { recursive: true }).then(() =>
      writeFile(paths.journal(id), JSON.stringify({ profileId: id, hadTarget: true, backupAvailable: true, startedAt: 'x', target })));
  const MESSAGE = "Finish or recover the unfinished sync before changing this profile's target.";

  it.each([
    ['host', (i: ProfileInput) => { i.target.host = '127.0.0.1'; }],
    ['port', (i: ProfileInput) => { i.target.port = 5434; }],
    ['database', (i: ProfileInput) => { i.target.database = 'other'; }],
  ])('refuses to change the target %s while a journal is pending', async (_l, mutate) => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    await pendingJournal(id);
    const change = input({ id });
    mutate(change);
    await expect(r.service.saveProfile(change)).rejects.toThrow(MESSAGE);
    expect((await r.store.get(id)).target).toMatchObject({ host: 'localhost', port: 5433, database: 'orders' });
  });

  it('still allows other edits, and target edits with no journal', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    const rename = input({ id, name: 'Renamed' });
    delete rename.source.password;
    delete rename.target.password;
    await pendingJournal(id);
    expect((await r.service.saveProfile(rename)).name).toBe('Renamed');
    await rm(paths.journal(id));
    const moved = input({ id });
    moved.target.port = 5434;
    expect((await r.service.saveProfile(moved)).target.port).toBe(5434);
  });

  it('treats a damaged journal as pending when the target changes', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(paths.journal(id), 'broken');
    const change = input({ id });
    change.target.database = 'other';
    await expect(r.service.saveProfile(change)).rejects.toThrow(MESSAGE);
  });

  it('refuses a target change while that profile is syncing', async () => {
    const g = gate();
    const r = rig({ runner: stubRunner({ sync: async () => { await g.promise; return cancelled(); } }) });
    const id = (await r.service.saveProfile(input())).id;
    const run = r.service.startSync(id);
    const change = input({ id });
    change.target.port = 5434;
    await expect(r.service.saveProfile(change)).rejects.toThrow(/running sync/i);
    g.open();
    await run;
  });

  const REFUSED = 'Finish or recover the unfinished sync before deleting this profile.';

  it('deleting a profile removes its backup and log files when no sync is unfinished', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    const other = (await r.service.saveProfile(input({ name: 'Other' }))).id;
    for (const who of [id, other]) {
      await mkdir(paths.backupLatest(who), { recursive: true });
      await mkdir(paths.logsDir(who), { recursive: true });
      await writeFile(join(paths.logsDir(who), 'a.log'), 'x');
    }
    await r.service.deleteProfile(id);
    expect(await exists(paths.backupDir(id))).toBe(false);
    expect(await exists(paths.logsDir(id))).toBe(false);
    expect(await exists(paths.backupDir(other))).toBe(true);
    expect((await r.service.listProfiles()).map((v) => v.id)).toEqual([other]);
  });

  it('refuses to delete a profile with an unfinished sync and leaves its backup and journal untouched', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    await mkdir(paths.backupLatest(id), { recursive: true });
    await writeFile(join(paths.backupLatest(id), 'data'), 'precious');
    await mkdir(paths.logsDir(id), { recursive: true });
    await pendingJournal(id);
    await expect(r.service.deleteProfile(id)).rejects.toThrow(REFUSED);
    expect(await exists(join(paths.backupLatest(id), 'data'))).toBe(true);
    expect(await exists(paths.journal(id))).toBe(true);
    expect(await exists(paths.logsDir(id))).toBe(true);
    expect((await r.service.listProfiles()).map((v) => v.id)).toEqual([id]);
  });

  it('refuses to delete a profile whose journal is damaged', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(paths.journal(id), '{ not json');
    await expect(r.service.deleteProfile(id)).rejects.toThrow(REFUSED);
    expect(await exists(paths.journal(id))).toBe(true);
    expect((await r.service.listProfiles()).map((v) => v.id)).toEqual([id]);
  });

  it('blocks a run that starts while a delete is checking, so a journal cannot appear mid-delete', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    const del = r.service.deleteProfile(id);
    await expect(r.service.startSync(id)).rejects.toThrow(/already running/i);
    await del;
  });

  it('puts the backup folder in the view only when a backup exists', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    expect((await r.service.listProfiles())[0].backupPath).toBeNull();
    await mkdir(paths.backupLatest(id), { recursive: true });
    expect((await r.service.listProfiles())[0].backupPath).toBe(paths.backupDir(id));
  });

  it.each(['..', '../x', 'a/b', '', 'a b'])('rejects the unsafe profile id %j', async (bad) => {
    const r = rig();
    await expect(r.service.deleteProfile(bad)).rejects.toThrow(/invalid profile id/i);
    await expect(r.service.startSync(bad)).rejects.toThrow(/invalid profile id/i);
    await expect(r.service.saveProfile(input({ id: bad }))).rejects.toThrow(/invalid profile id/i);
  });
});

describe('testConnection', () => {
  it('on target rejects a non-local host without connecting', async () => {
    const r = rig();
    const i = input();
    i.target.host = 'db.example.com';
    const res = await r.service.testConnection(i, 'target');
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ message: expect.stringMatching(/localhost/) });
    expect(r.openedWith).toEqual([]);
  });

  it('uses the stored password when input.password is undefined', async () => {
    const r = rig();
    const saved = await r.service.saveProfile(input());
    const i = input({ id: saved.id });
    delete i.source.password;
    delete i.target.password;
    const src = await r.service.testConnection(i, 'source');
    const tgt = await r.service.testConnection(i, 'target');
    expect(src).toMatchObject({ ok: true, versionLabel: '16', flavor: 'postgres' });
    expect(tgt.ok).toBe(true);
    expect(r.openedWith).toEqual([{ side: 'source', password: SOURCE_PW }, { side: 'target', password: TARGET_PW }]);
    expect(r.fake.closes).toEqual(['source', 'target']);
  });

  it('uses the typed password when one is given', async () => {
    const r = rig();
    const saved = await r.service.saveProfile(input());
    const i = input({ id: saved.id });
    i.source.password = 'typed';
    await r.service.testConnection(i, 'source');
    expect(r.openedWith).toEqual([{ side: 'source', password: 'typed' }]);
  });

  it('reports a connection failure without the password in it', async () => {
    const r = rig();
    const svc = createSyncService({
      store: r.store, runner: stubRunner(), paths, logs: createLogStore(paths),
      adapterFor: () => ({
        ...r.fake.adapter,
        openSource: async () => { throw new Error(`password authentication failed for ${SOURCE_PW}`); },
      }),
      checkTarget: async () => ({ allowed: true }), onEvent: () => undefined, onWarnings: () => undefined,
    });
    const res = await svc.testConnection(input(), 'source');
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SOURCE_PW);
  });

  it('asks for the password again when the stored one is unreadable', async () => {
    const seed = rig();
    const saved = await seed.service.saveProfile(input({ target: { ...input().target, password: 'lost' } }));
    const r = rig({ cipher: lossyCipher() });
    const i = input({ id: saved.id });
    delete i.target.password;
    const res = await r.service.testConnection(i, 'target');
    expect(res).toMatchObject({ ok: false, message: expect.stringMatching(/enter it again/i) });
    expect(r.openedWith).toEqual([]);
  });

  it('tests only the side asked about', async () => {
    const r = rig();
    const i = input();
    i.target.host = '';
    i.name = '';
    expect(await r.service.testConnection(i, 'source')).toMatchObject({ ok: true });
    const j = input();
    j.source.host = '';
    expect(await r.service.testConnection(j, 'target')).toMatchObject({ ok: true });
    expect(await r.service.testConnection(i, 'target')).toMatchObject({ ok: false, message: expect.stringMatching(/Target host is required/) });
  });

  it('does not send the stored source password to a changed host or port, and makes no driver call', async () => {
    const r = rig();
    const saved = await r.service.saveProfile(input());
    for (const change of [(i: ProfileInput) => { i.source.host = 'typo.example.com'; }, (i: ProfileInput) => { i.source.port = 6000; }]) {
      const i = input({ id: saved.id });
      change(i);
      delete i.source.password;
      expect(await r.service.testConnection(i, 'source')).toEqual({ ok: false, message: 'Enter the password for the new host.' });
      await expect(r.service.saveProfile(i)).rejects.toThrow('Enter the password for the new host.');
    }
    expect(r.openedWith).toEqual([]);
    const typed = input({ id: saved.id });
    typed.source.host = 'new.example.com';
    typed.source.password = 'typed';
    expect(await r.service.testConnection(typed, 'source')).toMatchObject({ ok: true });
    expect(r.openedWith).toEqual([{ side: 'source', password: 'typed' }]);
  });

  it('returns a message for invalid input instead of throwing', async () => {
    const r = rig();
    const i = input();
    i.source.host = ' ';
    expect(await r.service.testConnection(i, 'source')).toMatchObject({ ok: false, message: expect.stringMatching(/host is required/i) });
  });
});

describe('secrets', () => {
  it('no IPC response contains a password', async () => {
    const r = rig();
    const saved = await r.service.saveProfile(input());
    const outcome = await r.service.startSync(saved.id);
    const restore = await r.service.restoreBackup(saved.id);
    const everything = JSON.stringify([
      saved, await r.service.listProfiles(), outcome, restore, r.events, r.warnings,
      await r.service.testConnection(input(), 'source'),
    ]);
    expect(everything).not.toContain(SOURCE_PW);
    expect(everything).not.toContain(TARGET_PW);
  });

  it('redacts both passwords from log events, outcomes and the log file, for every kind of run', async () => {
    type Run = SyncRunner['sync'];
    const leak = (p: Parameters<Run>[0]) => `source ${p.source.password} target ${p.target.password}`;
    const run = (kind: string): Run => async (p, cb) => {
      cb.onEvent({ type: 'log', line: `${kind}: ${leak(p)}` });
      cb.onEvent({ type: 'progress', label: leak(p), percent: null });
      return { status: 'failed', step: 'replace', targetState: 'recovery-failed', message: leak(p), details: leak(p) };
    };
    const r = rig({ runner: stubRunner({ sync: run('sync'), restoreBackup: run('restore'), recover: run('recover') }) });
    const id = (await r.service.saveProfile(input())).id;
    const outcomes = [await r.service.startSync(id), await r.service.restoreBackup(id), await r.service.recover(id)];
    const sent = JSON.stringify([r.events, outcomes, await r.service.listProfiles()]);
    expect(sent).not.toContain(SOURCE_PW);
    expect(sent).not.toContain(TARGET_PW);
    expect(r.events.some(([, e]) => e.type === 'log' && e.line === 'sync: source *** target ***')).toBe(true);
    const texts = await logTexts(id);
    expect(texts).toHaveLength(3);
    for (const text of texts) {
      expect(text).not.toContain(SOURCE_PW);
      expect(text).not.toContain(TARGET_PW);
    }
    expect(texts.some((t) => t.includes('recover: source *** target ***'))).toBe(true);
    expect(texts.some((t) => t.includes('restore: source *** target ***'))).toBe(true);
  });

  it('writes the steps and the result of a run to that run file', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    await r.service.startSync(id);
    const [text] = await logTexts(id);
    expect(text).toMatch(/Step: check/);
    expect(text).toMatch(/Step: replace/);
    expect(text).toMatch(/Result: success/);
  });

  it('a log failure does not fail the run', async () => {
    const r = rig();
    const id = (await r.service.saveProfile(input())).id;
    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(paths.logsDir(id), 'a file where the log folder should be');
    expect((await r.service.startSync(id)).status).toBe('success');
  });

  it('redacts a thrown error before it leaves the service', async () => {
    const r = rig({ runner: stubRunner({ sync: async (p) => { throw new Error(`bad ${p.target.password}`); } }) });
    const id = (await r.service.saveProfile(input())).id;
    const err = (await r.service.startSync(id).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('bad ***');
  });
});
