import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, guardedQuery } from '../../src/main/engines/mysql/connection';
import { createMysqlAdapter } from '../../src/main/engines/mysql/mysql-adapter';
import { defaultsFileContent, dumpArgs } from '../../src/main/engines/mysql/args';
import { DropBlockedError, type EngineAdapter, type StepContext } from '../../src/main/engines/adapter';
import { ToolError, runTool, type ToolRun } from '../../src/main/process/process-runner';
import { writeJournal } from '../../src/main/sync/journal';
import { createToolLocator } from '../../src/main/tools/tool-locator';
import type { Endpoint, Profile, SyncEvent, SyncOutcome } from '../../src/shared/types';
import { BUNDLED_TOOLS, startTempServers, type TempServer } from './harness/temp-server';
import { createTestRunner, runSyncForTest } from './harness/sync-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

// Every tool run goes through here, so a test can see exactly what the adapter handed to the bundled tools.
const toolRuns = vi.hoisted(() => [] as Array<{ command: string; args: string[]; env: Record<string, string> }>);
vi.mock('../../src/main/process/process-runner', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/process/process-runner')>();
  return {
    ...real,
    runTool: (run: ToolRun) => {
      toolRuns.push({ command: run.command, args: [...run.args], env: { ...run.env } });
      return real.runTool(run);
    },
  };
});

const WEIRD_PASSWORD = `p@ss"w\\ord'1`;
const FIXTURE = join(import.meta.dirname, 'fixtures', 'mysql.sql');
const FLAVORS = ['mysql', 'mariadb'] as const;

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const ctx = (): StepContext => ({ signal: new AbortController().signal, onLog: () => undefined, onProgress: () => undefined });
const statementsOf = (sql: string) => sql.split(/\r?\n-- split\r?\n/).map((s) => s.trim()).filter(Boolean);
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Compares the raw text of every event, outcome message and details, not a JSON encoding that would escape quotes. */
function expectNoSecret(secret: string, events: SyncEvent[], outcome?: SyncOutcome) {
  const raw = events.map((e) => (e.type === 'log' ? e.line : e.type === 'progress' ? e.label : e.step));
  if (outcome?.status === 'failed') raw.push(outcome.message, outcome.details);
  expect(raw.filter((text) => text.includes(secret))).toEqual([]);
}

describe.each(FLAVORS)('%s adapter', (flavor) => {
  let source: TempServer; // the "dev" server
  let local: TempServer; // the "local" server
  let trusting: TempServer; // a local server whose user has an empty password
  let workDir: string;
  let rootDir: string; // the folder name has spaces and an accent on purpose
  let tmpRoot: string;
  let adapter: EngineAdapter;
  const conns: Connection[] = [];
  let counter = 0;

  const locate = createToolLocator(BUNDLED_TOOLS);
  const connectTo = async (server: TempServer, database?: string, password = server.password, user = server.user) => {
    const c = await mysql.createConnection({ host: server.host, port: server.port, user, password, database });
    c.on('error', () => undefined);
    conns.push(c);
    return c;
  };
  const withClient = async <T>(server: TempServer, database: string | undefined, fn: (c: Connection) => Promise<T>, password?: string, user?: string) => {
    const c = await connectTo(server, database, password, user);
    try { return await fn(c); } finally { await c.end().catch(() => undefined); }
  };
  const rows = async (c: Connection, sql: string, params: unknown[] = []) => (await c.query(sql, params))[0] as Row[];
  const createDb = (server: TempServer, name: string, statements: string[] = []) =>
    withClient(server, undefined, async (c) => {
      await c.query(`CREATE DATABASE ${mysql.escapeId(name)}`);
      await c.query(`USE ${mysql.escapeId(name)}`);
      for (const sql of statements) await c.query(sql);
    });
  const databases = (server: TempServer) =>
    withClient(server, undefined, async (c) => (await rows(c, 'SHOW DATABASES')).map((r) => String(r.Database)).sort());
  const dbExists = async (server: TempServer, name: string) => (await databases(server)).includes(name);
  const select = (server: TempServer, database: string, sql: string, password?: string, user?: string) =>
    withClient(server, database, (c) => rows(c, sql), password, user);
  const createUser = (server: TempServer, user: string, password: string, grant = 'ALL PRIVILEGES ON *.*') =>
    withClient(server, undefined, async (c) => {
      await c.query(`CREATE USER ${mysql.escape(user)}@'%' IDENTIFIED BY ${mysql.escape(password)}`);
      await c.query(`GRANT ${grant} TO ${mysql.escape(user)}@'%'`);
    });

  const endpoint = (server: TempServer, database: string, password = server.password): Endpoint =>
    ({ host: server.host, port: server.port, user: server.user, password, database });
  const profileFor = (
    srcDb: string, tgtDb: string,
    over: { src?: Endpoint; tgt?: TempServer | Endpoint; srcPassword?: string; tgtPassword?: string; backupEnabled?: boolean } = {},
  ): Profile => {
    const id = `${flavor}${++counter}`;
    const tgt = over.tgt && 'host' in over.tgt && 'database' in over.tgt ? over.tgt : endpoint((over.tgt as TempServer | undefined) ?? local, tgtDb, over.tgtPassword);
    return {
      id, name: id, engine: 'mysql', backupEnabled: over.backupEnabled ?? true,
      source: { ...(over.src ?? endpoint(source, srcDb, over.srcPassword)), ssl: false },
      target: tgt,
    };
  };

  /** Everything the fixture creates, in a form two databases can be compared by. */
  const snapshot = (server: TempServer, database: string, password?: string) =>
    withClient(server, database, async (c) => ({
      customers: await rows(c, 'SELECT * FROM customers ORDER BY id'),
      orders: await rows(c, 'SELECT * FROM orders ORDER BY id'),
      audit: await rows(c, 'SELECT * FROM audit ORDER BY id'),
      blobs: await rows(c, 'SELECT id, SHA2(data, 256) AS hash, LENGTH(data) AS len FROM blobs ORDER BY id'),
      view: await rows(c, 'SELECT * FROM order_totals ORDER BY name'),
      tables: await rows(c, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1'),
    }), password);

  /** No password file may outlive a run, and none may be left on disk by the runs recorded so far. */
  async function expectNoDefaultsFiles() {
    const left = (await fs.readdir(tmpRoot).catch(() => [] as string[])).filter((f) => /\.cnf$/.test(f));
    expect(left).toEqual([]);
    for (const run of toolRuns) {
      const first = run.args[0] ?? '';
      if (run.command.includes(flavor === 'mysql' ? 'mysql' : 'mariadb') && first.startsWith('--defaults-extra-file=')) {
        expect(await exists(first.slice('--defaults-extra-file='.length))).toBe(false);
      }
    }
  }

  /** Rewrites a gzipped dump so it fails partway: the tables before the marker load, then the client hits `garbage`. */
  async function corruptDump(file: string, garbage: string) {
    const text = gunzipSync(await fs.readFile(file)).toString('utf8');
    const marker = '-- Table structure for table `orders`';
    expect(text).toContain(marker);
    await fs.writeFile(file, gzipSync(text.replace(marker, () => `${garbage};\n${marker}`)));
  }

  beforeAll(async () => {
    [source, local, trusting] = await startTempServers([flavor], [flavor], [flavor, { emptyPassword: true }]);
    workDir = await fs.mkdtemp(join(tmpdir(), 'dbsync-it-'));
    rootDir = join(workDir, 'dá ta sync');
    tmpRoot = join(rootDir, 'tmp');
    adapter = createMysqlAdapter({ locate, tmpRoot });
    await createUser(source, 'dev_owner', 'dev-owner-pw'); // the definer in the fixture; it exists on dev only
    await withClient(source, undefined, async (c) => {
      await c.query('CREATE DATABASE dev_app');
      await c.query('USE dev_app');
      for (const sql of statementsOf(await fs.readFile(FIXTURE, 'utf8'))) await c.query(sql);
    });
  });

  afterEach(async () => {
    await expectNoDefaultsFiles();
  });

  afterAll(async () => {
    await Promise.all(conns.map((c) => c.end().catch(() => undefined)));
    await Promise.all([source, local, trusting].map((s) => s?.stop()));
    if (workDir) await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  describe('sync', () => {
    it('copies schema and data exactly', async () => {
      await createDb(local, 'copy_t');
      const { outcome, events } = await runSyncForTest(adapter, profileFor('dev_app', 'copy_t'), rootDir);
      expect(outcome).toMatchObject({ status: 'success', targetState: 'replaced', warnings: [] });

      const want = await snapshot(source, 'dev_app');
      const got = await snapshot(local, 'copy_t');
      expect(got).toEqual(want);
      expect(got.customers[0].bio).toBe('Hello 😀 wörld — ünïcode ✓');
      expect(got.blobs[0]).toMatchObject({ len: 256 });
      expect(got.blobs[0].hash).toBe((await select(source, 'dev_app', 'SELECT SHA2(data, 256) AS h FROM blobs'))[0].h);
      expect(got.audit.length).toBe(3);

      await withClient(local, 'copy_t', async (c) => {
        await c.query('INSERT INTO orders (customer_id, total) VALUES (1, 1)');
        expect((await rows(c, 'SELECT COUNT(*) AS n FROM audit'))[0].n).toBe(4); // the trigger fires
        await c.query('CALL add_order(2, 5.00)'); // the procedure is callable
        expect((await rows(c, 'SELECT COUNT(*) AS n FROM orders'))[0].n).toBe(5);
        expect((await rows(c, 'SELECT add_one(41) AS v'))[0].v).toBe(42); // the function is callable
        expect((await rows(c, `SELECT event_name AS n FROM information_schema.events WHERE event_schema = 'copy_t'`)).map((r) => r.n)).toEqual(['cleanup_audit']);
        expect((await rows(c, 'SELECT total FROM order_totals WHERE name = "Bob"'))[0].total).toBe('104.99'); // the view works
        await c.query(`INSERT INTO customers (name) VALUES ('Cy')`);
        expect((await rows(c, `SELECT id FROM customers WHERE name = 'Cy'`))[0].id).toBe(100); // auto-increment continues
        expect((await rows(c, 'SELECT @@foreign_key_checks AS f'))[0].f).toBe(1);
        await expect(c.query('INSERT INTO orders (customer_id, total) VALUES (999, 1)')).rejects.toThrow(/foreign key/i);
      });
      expect(events.some((e) => e.type === 'progress' && e.percent === 100)).toBe(true);
    });

    it('removes definers so a restore works without the source user', async () => {
      await createDb(local, 'definer_t');
      expect((await select(local, 'definer_t', `SELECT user FROM mysql.user WHERE user = 'dev_owner'`))).toEqual([]);
      expect((await runSyncForTest(adapter, profileFor('dev_app', 'definer_t'), rootDir)).outcome.status).toBe('success');
      const owners = await withClient(local, 'definer_t', async (c) => [
        ...(await rows(c, `SELECT definer AS d FROM information_schema.routines WHERE routine_schema = 'definer_t'`)),
        ...(await rows(c, `SELECT definer AS d FROM information_schema.triggers WHERE trigger_schema = 'definer_t'`)),
        ...(await rows(c, `SELECT definer AS d FROM information_schema.events WHERE event_schema = 'definer_t'`)),
        ...(await rows(c, `SELECT definer AS d FROM information_schema.views WHERE table_schema = 'definer_t'`)),
      ].map((r) => String(r.d)));
      expect(owners.length).toBe(5); // two routines, a trigger, an event and a view
      expect(owners.filter((d) => d.includes('dev_owner'))).toEqual([]);
      expect(new Set(owners)).toEqual(new Set([`${local.user}@%`]));
      // The source still has its own definers.
      expect((await select(source, 'dev_app', `SELECT definer AS d FROM information_schema.routines WHERE routine_schema = 'dev_app'`))[0].d)
        .toContain('dev_owner');
    });

    it('leaves row text containing DEFINER unchanged', async () => {
      await createDb(local, 'rowtext_t');
      expect((await runSyncForTest(adapter, profileFor('dev_app', 'rowtext_t'), rootDir)).outcome.status).toBe('success');
      expect((await select(local, 'rowtext_t', `SELECT bio FROM customers WHERE name = 'Bob'`))[0].bio)
        .toBe('literal text: CREATE DEFINER=`root`@`%` x');
    });

    it('overwrites existing target data', async () => {
      await createDb(local, 'over_t', ['CREATE TABLE local_only (id INT)', 'INSERT INTO local_only VALUES (1)']);
      const { outcome } = await runSyncForTest(adapter, profileFor('dev_app', 'over_t'), rootDir);
      expect(outcome.status).toBe('success');
      const got = await snapshot(local, 'over_t');
      expect(got.tables.map((t) => t.t)).not.toContain('local_only');
      expect(got).toEqual(await snapshot(source, 'dev_app'));
    });

    it('takes a backup that restoreBackup brings back', async () => {
      await createDb(local, 'back_t', ['CREATE TABLE precious (id INT, v TEXT)', `INSERT INTO precious VALUES (1, 'mine 😀')`]);
      const profile = profileFor('dev_app', 'back_t');
      const { runner, paths, run } = createTestRunner(adapter, rootDir);

      expect((await run((cb) => runner.sync(profile, cb))).outcome.status).toBe('success');
      expect(await exists(paths.backupLatest(profile.id))).toBe(true);
      expect((await snapshot(local, 'back_t')).tables.map((t) => t.t)).not.toContain('precious');

      const { outcome } = await run((cb) => runner.restoreBackup(profile, cb));
      expect(outcome).toMatchObject({ status: 'success', targetState: 'restored-from-backup' });
      expect(await select(local, 'back_t', 'SELECT * FROM precious')).toEqual([{ id: 1, v: 'mine 😀' }]);
      expect(await select(local, 'back_t', `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'back_t' AND table_name = 'customers'`))
        .toEqual([{ n: 0 }]);
    });

    it('works with database name "order-db test" and password p@ss"w\\ord\'1', async () => {
      const name = 'order-db test';
      await createUser(source, 'weird', WEIRD_PASSWORD);
      await createUser(local, 'weird', WEIRD_PASSWORD);
      await createDb(source, name, ['CREATE TABLE t (id INT)', 'INSERT INTO t VALUES (7)']);
      await createDb(local, name, ['CREATE TABLE old (id INT)']);
      const srcEp = { ...endpoint(source, name, WEIRD_PASSWORD), user: 'weird' };
      const tgtEp = { ...endpoint(local, name, WEIRD_PASSWORD), user: 'weird' };
      const profile = profileFor(name, name, { src: srcEp, tgt: tgtEp });
      toolRuns.length = 0;
      const { outcome, events } = await runSyncForTest(adapter, profile, rootDir);
      expect(outcome.status).toBe('success');
      expectNoSecret(WEIRD_PASSWORD, events, outcome);
      expect(toolRuns.length).toBeGreaterThan(0);
      for (const run of toolRuns) expect(run.args.some((a) => a.includes(WEIRD_PASSWORD))).toBe(false);
      expect(await select(local, name, 'SELECT id FROM t', WEIRD_PASSWORD, 'weird')).toEqual([{ id: 7 }]);
    });

    it('keeps the password out of everything a failed restore shows, even when the tool echoes it', async () => {
      await createDb(local, 'echo_t', ['CREATE TABLE precious (id INT)', 'INSERT INTO precious VALUES (1)']);
      // The first token of a bad statement is quoted back by the client's error message.
      let corrupted = false;
      const faulty: EngineAdapter = {
        openSource: (e) => adapter.openSource(e),
        engineChecks: (s, t) => adapter.engineChecks(s, t),
        async openTarget(e) {
          const real = await adapter.openTarget(e);
          return {
            ...real,
            async restore(dumpPath, c) {
              if (!corrupted) { corrupted = true; await corruptDump(dumpPath, WEIRD_PASSWORD); }
              return real.restore(dumpPath, c);
            },
          };
        },
      };
      await createUser(local, 'echo_user', WEIRD_PASSWORD);
      const profile = profileFor('dev_app', 'echo_t', { tgt: { ...endpoint(local, 'echo_t', WEIRD_PASSWORD), user: 'echo_user' } });
      toolRuns.length = 0;
      const { runner, run } = createTestRunner(faulty, rootDir);
      const { outcome, events } = await run((cb) => runner.sync(profile, cb));
      expect(outcome).toMatchObject({ status: 'failed', step: 'replace', targetState: 'restored-from-backup' });
      expectNoSecret(WEIRD_PASSWORD, events, outcome);
      // The error text did quote the password, so the redaction is what removed it.
      expect(outcome.status === 'failed' && outcome.details).toContain('***');
      for (const r of toolRuns) expect(r.args.some((a) => a.includes(WEIRD_PASSWORD))).toBe(false);
    });

    it('works when the target has an empty password', async () => {
      await createDb(trusting, 'empty_pw_t', ['CREATE TABLE gone (id INT)']);
      toolRuns.length = 0;
      const { outcome } = await runSyncForTest(adapter, profileFor('dev_app', 'empty_pw_t', { tgt: trusting }), rootDir);
      expect(outcome.status).toBe('success');
      expect(await snapshot(trusting, 'empty_pw_t')).toEqual(await snapshot(source, 'dev_app'));
    });

    it('ignores inherited MYSQL_PWD and MYSQL_HOST', async () => {
      const bogus = {
        MYSQL_PWD: 'bogus-password', MYSQL_HOST: 'bogus.invalid', MYSQL_TCP_PORT: '1', MYSQL_HOME: 'C:\\nowhere',
        MARIADB_HOST: 'bogus.invalid', MARIADB_PWD: 'bogus-password',
      };
      const saved = Object.fromEntries(Object.keys(bogus).map((k) => [k, process.env[k]]));
      await createDb(local, 'env_t');
      Object.assign(process.env, bogus);
      try {
        const { outcome } = await runSyncForTest(adapter, profileFor('dev_app', 'env_t'), rootDir);
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'success' });
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
      expect((await snapshot(local, 'env_t')).customers.length).toBe(2);
    });

    it('syncs an empty source database', async () => {
      await createDb(source, 'empty_src');
      await createDb(local, 'empty_t', ['CREATE TABLE old (id INT)']);
      const { outcome } = await runSyncForTest(adapter, profileFor('empty_src', 'empty_t'), rootDir);
      expect(outcome).toMatchObject({ status: 'success', warnings: [] });
      expect(await select(local, 'empty_t', 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()')).toEqual([{ n: 0 }]);
    });

    it('does a first sync when the target does not exist', async () => {
      expect(await dbExists(local, 'fresh_t')).toBe(false);
      const profile = profileFor('dev_app', 'fresh_t');
      const { runner, paths, run } = createTestRunner(adapter, rootDir);
      const { outcome, events } = await run((cb) => runner.sync(profile, cb));
      expect(outcome).toMatchObject({ status: 'success', targetState: 'replaced' });
      expect(await exists(paths.backupLatest(profile.id))).toBe(false);
      expect(await exists(paths.backupDir(profile.id))).toBe(false);
      expect(events.filter((e) => e.type === 'step').map((e) => e.step)).not.toContain('backup');
      expect(await snapshot(local, 'fresh_t')).toEqual(await snapshot(source, 'dev_app'));
    });

    it('never changes the source', async () => {
      const state = () => withClient(source, 'dev_app', async (c) => {
        const out: Record<string, unknown> = {};
        for (const t of ['customers', 'orders', 'audit', 'blobs']) out[t] = (await rows(c, `SELECT COUNT(*) AS n FROM ${t}`))[0].n;
        out.tables = await rows(c, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1');
        out.autoIncrement = (await rows(c, `SELECT auto_increment AS v FROM information_schema.tables WHERE table_schema = 'dev_app' AND table_name = 'customers'`))[0].v;
        out.dbs = await databases(source);
        return out;
      });
      const before = await state();
      await createDb(local, 'ro_t');
      expect((await runSyncForTest(adapter, profileFor('dev_app', 'ro_t'), rootDir)).outcome.status).toBe('success');
      expect(await state()).toEqual(before);
    });

    it('warns about non-InnoDB tables', async () => {
      await createDb(source, 'myisam_src', ['CREATE TABLE a (id INT) ENGINE=InnoDB', 'CREATE TABLE m (id INT) ENGINE=MyISAM', 'INSERT INTO m VALUES (1)']);
      await createDb(local, 'myisam_t');
      const s = await adapter.openSource({ ...endpoint(source, 'myisam_src'), ssl: false });
      const t = await adapter.openTarget(endpoint(local, 'myisam_t'));
      try {
        const issues = await adapter.engineChecks(s, t);
        expect(issues).toEqual([expect.objectContaining({ severity: 'warning', code: 'non-transactional-tables' })]);
        expect(issues[0].message).toContain('MyISAM');
        expect(issues[0].message).toContain('(MyISAM: m)'); // only the MyISAM table is listed, not the InnoDB one
      } finally {
        await s.close();
        await t.close();
      }
      const { outcome } = await runSyncForTest(adapter, profileFor('myisam_src', 'myisam_t'), rootDir);
      expect(outcome).toMatchObject({ status: 'success', warnings: [expect.objectContaining({ code: 'non-transactional-tables' })] });
      expect(await select(local, 'myisam_t', 'SELECT id FROM m')).toEqual([{ id: 1 }]);
    });

    it('engineChecks finds no issues for an all-InnoDB source', async () => {
      await createDb(local, 'chk_t');
      const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
      const t = await adapter.openTarget(endpoint(local, 'chk_t'));
      try {
        expect(await adapter.engineChecks(s, t)).toEqual([]);
      } finally {
        await s.close();
        await t.close();
      }
    });

    it('kills connected clients and drops the target', async () => {
      await createDb(local, 'busy_t', ['CREATE TABLE old (id INT)', 'INSERT INTO old VALUES (1)']);
      const squatter = await connectTo(local, 'busy_t');
      await squatter.query('START TRANSACTION');
      await squatter.query('SELECT * FROM old'); // holds a metadata lock that would block the drop
      const started = Date.now();
      const { outcome } = await runSyncForTest(adapter, profileFor('dev_app', 'busy_t'), rootDir);
      expect(outcome.status).toBe('success');
      expect(Date.now() - started).toBeLessThan(25_000);
      expect((await snapshot(local, 'busy_t')).customers.length).toBe(2);
      await expect(squatter.query('SELECT 1')).rejects.toThrow(); // it was disconnected
    });

    it('reports DropBlockedError when the drop times out, with the target data intact', async () => {
      await createDb(local, 'locked_t', ['CREATE TABLE keep (id INT)', 'INSERT INTO keep VALUES (1), (2)']);
      const squatter = await connectTo(local, 'locked_t');
      await squatter.query('START TRANSACTION');
      await squatter.query('SELECT * FROM keep');
      const blocking = createMysqlAdapter({ locate, tmpRoot, killClients: async () => undefined });
      const t = await blocking.openTarget(endpoint(local, 'locked_t'));
      const started = Date.now();
      try {
        const err = await t.dropDatabase(ctx()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DropBlockedError);
        expect((err as DropBlockedError).clients.length).toBeGreaterThan(0);
        expect(Date.now() - started).toBeGreaterThanOrEqual(29_000); // it waited out the 30 s lock_wait_timeout
      } finally {
        await t.close();
      }
      expect(await select(local, 'locked_t', 'SELECT id FROM keep ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
      await squatter.query('SELECT 1'); // still connected
    });

    it('recovers the old data when the restore fails partway', async () => {
      await createDb(local, 'fail_t', ['CREATE TABLE precious (id INT)', 'INSERT INTO precious VALUES (1), (2)']);
      // Breaks the dump after its first tables, then uses the real restore, including for recovery.
      let corrupted = false;
      const faulty: EngineAdapter = {
        openSource: (e) => adapter.openSource(e),
        engineChecks: (s, t) => adapter.engineChecks(s, t),
        async openTarget(e) {
          const real = await adapter.openTarget(e);
          return {
            ...real,
            async restore(dumpPath, c) {
              if (!corrupted) { corrupted = true; await corruptDump(dumpPath, 'THIS IS NOT SQL'); }
              return real.restore(dumpPath, c);
            },
          };
        },
      };
      const profile = profileFor('dev_app', 'fail_t');
      const { runner, paths, run } = createTestRunner(faulty, rootDir);
      const { outcome } = await run((cb) => runner.sync(profile, cb));
      expect(outcome).toMatchObject({ status: 'failed', step: 'replace', targetState: 'restored-from-backup' });
      expect(outcome.status === 'failed' && outcome.message).toMatch(/syntax/i);
      expect(corrupted).toBe(true);
      expect(await select(local, 'fail_t', 'SELECT id FROM precious ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await exists(paths.journal(profile.id))).toBe(false);
      expect(await exists(paths.tmpDump(profile.id))).toBe(false);
    });

    it('stops at the first error, after the earlier part of the dump has applied', async () => {
      await createDb(local, 'stop_t');
      const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
      const dump = join(workDir, `stop-${flavor}.sql.gz`);
      try { await s.dump(dump, ctx()); } finally { await s.close(); }
      await corruptDump(dump, 'THIS IS NOT SQL');
      const t = await adapter.openTarget(endpoint(local, 'stop_t'));
      try {
        await expect(t.restore(dump, ctx())).rejects.toBeInstanceOf(ToolError);
      } finally {
        await t.close();
      }
      const tables = (await select(local, 'stop_t', 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1')).map((r) => r.t);
      expect(tables).toEqual(expect.arrayContaining(['audit', 'blobs', 'customers'])); // applied before the error
      expect(tables).not.toContain('orders'); // not applied after it
    });

    it('treats MyDb and mydb on one server as the same database', async (t) => {
      const fold = Number((await select(local, 'information_schema', 'SELECT @@lower_case_table_names AS v'))[0].v);
      if (fold === 0) return t.skip();
      await createDb(local, 'CaseKeep', ['CREATE TABLE keep (id INT)', 'INSERT INTO keep VALUES (1)']);
      const profile = profileFor('CaseKeep', 'casekeep', { src: endpoint(local, 'CaseKeep') });
      const { outcome } = await runSyncForTest(adapter, profile, rootDir);
      expect(outcome).toMatchObject({ status: 'failed', step: 'check', targetState: 'untouched' });
      expect(outcome.status === 'failed' && outcome.details).toContain('same-database');
      expect(await select(local, 'casekeep', 'SELECT id FROM keep')).toEqual([{ id: 1 }]);

      const mixed = await adapter.openTarget(endpoint(local, 'MyDb'));
      const plain = await adapter.openSource({ ...endpoint(local, 'MyDb'), ssl: false });
      try {
        expect(await mixed.databaseKey()).toBe('mydb');
        expect(await plain.databaseKey()).toBe('mydb');
      } finally {
        await mixed.close();
        await plain.close();
      }
    });

    it('keeps passwords out of the events and failure text of a failed sync', async () => {
      const profile = profileFor('dev_app', 'wrong_pw_t', { srcPassword: WEIRD_PASSWORD });
      const { outcome, events } = await runSyncForTest(adapter, profile, rootDir);
      expect(outcome.status).toBe('failed');
      expectNoSecret(WEIRD_PASSWORD, events, outcome);
      expectNoSecret(local.password, events, outcome);
      expectNoSecret(source.password, events, outcome);
    });
  });

  describe('contracts the sync runner relies on', () => {
    it('opens a target whose database does not exist', async () => {
      const t = await adapter.openTarget(endpoint(local, 'never_created'));
      try {
        expect(await t.exists()).toBe(false);
        expect(await t.sizeBytes()).toBe(0);
        expect(await t.listTables()).toEqual([]);
        expect(await t.createOptions()).toEqual({});
        expect(await t.canCreateDatabase()).toBe(true);
        const info = await t.info();
        expect(info.flavor).toBe(flavor);
        expect(info.version[0]).toBeGreaterThan(0);
      } finally {
        await t.close();
      }
      expect((await databases(local)).filter((d) => d.startsWith('__dbsync_probe_'))).toEqual([]);
    });

    it('treats dropDatabase on an absent database as a no-op that touches nothing else', async () => {
      const before = await databases(local);
      const t = await adapter.openTarget(endpoint(local, 'never_created'));
      try {
        await expect(t.dropDatabase(ctx())).resolves.toBeUndefined();
        await expect(t.dropDatabase(ctx())).resolves.toBeUndefined();
      } finally {
        await t.close();
      }
      expect(await databases(local)).toEqual(before);
    });

    it('drops only the target database, and a created one can be dropped again', async () => {
      await createDb(local, 'drop_me');
      await createDb(local, 'drop_me_not');
      const before = await databases(local);
      const t = await adapter.openTarget(endpoint(local, 'drop_me'));
      try {
        await t.dropDatabase(ctx());
        expect(await t.exists()).toBe(false);
        await t.createDatabase({ charset: 'utf8mb4' });
        expect(await t.exists()).toBe(true);
      } finally {
        await t.close();
      }
      expect(await databases(local)).toEqual(before);
    });

    it('reports server info with the flavor, a version and a server identity only where there is one', async () => {
      const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
      const t = await adapter.openTarget(endpoint(local, 'not_made_yet'));
      try {
        for (const info of [await s.info(), await t.info()]) {
          expect(info.flavor).toBe(flavor);
          expect(info.versionLabel).toBe(`${info.version[0]}.${info.version[1]}`);
          if (flavor === 'mysql') expect(info.identity).toMatch(/^[0-9a-f-]{36}$/);
          else expect(info.identity).toBeNull();
        }
        if (flavor === 'mysql') expect((await s.info()).identity).not.toBe((await t.info()).identity);
      } finally {
        await s.close();
        await t.close();
      }
    });

    it('creates the database with the source character set and collation', async () => {
      await createDb(source, 'latin_src');
      await withClient(source, undefined, (c) => c.query('ALTER DATABASE latin_src CHARACTER SET latin1 COLLATE latin1_swedish_ci'));
      const s = await adapter.openSource({ ...endpoint(source, 'latin_src'), ssl: false });
      const t = await adapter.openTarget(endpoint(local, 'latin_t'));
      try {
        const options = await s.createOptions();
        expect(options).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
        await t.createDatabase(options);
        expect(await t.createOptions()).toEqual(options);
        await t.dropDatabase(ctx());
      } finally {
        await s.close();
        await t.close();
      }
    });
  });

  describe('limits and refusals', () => {
    it('reports a drop the user may not do as blocked, deletes nothing and leaves the target untouched', async () => {
      await createUser(local, 'limited', 'limited-pw', 'SELECT, INSERT, CREATE ON *.*');
      await withClient(local, undefined, (c) =>
        c.query("GRANT ALL ON `\\_\\_dbsync\\_probe\\_%`.* TO 'limited'@'%'")); // so the create-privilege probe can clean up
      const limitedServer: TempServer = { ...local, user: 'limited', password: 'limited-pw' };
      await createDb(local, 'guarded_t', ['CREATE TABLE keep (id INT)', 'INSERT INTO keep VALUES (1), (2)']);
      const squatter = await connectTo(local, 'guarded_t');
      await squatter.query('SELECT 1');

      // What the server really answers to the limited user.
      const limited = await connectTo(limitedServer);
      const refused = await limited.query('DROP DATABASE guarded_t').catch((e: unknown) => e as { errno?: number });
      expect([1044, 1227, 1142]).toContain((refused as { errno?: number }).errno);

      const t = await adapter.openTarget(endpoint(limitedServer, 'guarded_t'));
      try {
        await expect(t.dropDatabase(ctx())).rejects.toBeInstanceOf(DropBlockedError);
      } finally {
        await t.close();
      }

      const profile = profileFor('dev_app', 'guarded_t', { backupEnabled: false, tgt: endpoint(limitedServer, 'guarded_t') });
      const { outcome } = await runSyncForTest(adapter, profile, rootDir);
      expect(outcome).toMatchObject({ status: 'failed', step: 'replace', targetState: 'untouched' });
      expect(await select(local, 'guarded_t', 'SELECT id FROM keep ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
      expect((await databases(local)).filter((d) => d.startsWith('__dbsync_probe_'))).toEqual([]);
      await squatter.query('SELECT 1'); // still connected
    });

    it('does not drop when the signal is already aborted', async () => {
      await createDb(local, 'abort_drop_t');
      const t = await adapter.openTarget(endpoint(local, 'abort_drop_t'));
      try {
        const ac = new AbortController();
        ac.abort();
        await expect(t.dropDatabase({ ...ctx(), signal: ac.signal })).rejects.toThrow(/cancel/i);
      } finally {
        await t.close();
      }
      expect(await dbExists(local, 'abort_drop_t')).toBe(true);
    });

    it('stops a slow query when the signal aborts', async () => {
      const conn = await connect(endpoint(local, 'mysql'), false);
      conns.push(conn);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const started = Date.now();
      await expect(guardedQuery(conn, 'SELECT SLEEP(60)', [], { signal: ac.signal })).rejects.toThrow(/cancel/i);
      expect(Date.now() - started).toBeLessThan(10_000);
      await expect(conn.query('SELECT 1')).rejects.toThrow(); // the connection was destroyed
    });

    it('gives up on a slow query at the deadline', async () => {
      const conn = await connect(endpoint(local, 'mysql'), false);
      conns.push(conn);
      const started = Date.now();
      await expect(guardedQuery(conn, 'SELECT SLEEP(60)', [], { timeoutMs: 300 })).rejects.toThrow(/did not answer/);
      expect(Date.now() - started).toBeLessThan(10_000);
      await expect(conn.query('SELECT 1')).rejects.toThrow();
    });

    it('rejects a blank host, user or database before connecting', async () => {
      const closedPort = { ...endpoint(local, 'x'), port: 1 }; // a connection attempt would say ECONNREFUSED instead
      for (const [field, message] of [['host', /host is required/], ['user', /user is required/], ['database', /database name is required/]] as const) {
        for (const blank of ['', '   ']) {
          const bad = { ...closedPort, [field]: blank };
          await expect(adapter.openTarget(bad)).rejects.toThrow(message);
          await expect(adapter.openSource({ ...bad, ssl: false })).rejects.toThrow(message);
        }
      }
    });

    it('dumps over a file that is already there', async () => {
      const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
      const dest = join(workDir, `leftover-${flavor}.sql.gz`);
      await fs.writeFile(dest, 'left by a crash, and not even gzip');
      try {
        await s.dump(dest, ctx());
      } finally {
        await s.close();
      }
      const sql = gunzipSync(await fs.readFile(dest)).toString('utf8');
      expect(sql).toContain('CREATE TABLE `customers`');
      expect(sql).not.toContain('left by a crash');
      // Definers are gone from the dump, and row text is untouched.
      expect(sql).not.toContain('DEFINER=`dev_owner`');
      expect(sql).toContain('CREATE DEFINER=`root`@`%` x');
    });

    it('dumps over a folder that is already there', async () => {
      const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
      const dest = join(workDir, `leftover-dir-${flavor}`);
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(join(dest, 'stale.txt'), 'left by a crash');
      try {
        await s.dump(dest, ctx());
      } finally {
        await s.close();
      }
      expect(gunzipSync(await fs.readFile(dest)).toString('utf8')).toContain('CREATE TABLE `customers`');
    });

    it('fails the dump with the tool error when the database is not there', async () => {
      const s = await adapter.openSource({ ...endpoint(source, 'no_such_dev_db'), ssl: false });
      try {
        await expect(s.dump(join(workDir, `fail-dump-${flavor}.sql.gz`), ctx())).rejects.toBeInstanceOf(ToolError);
      } finally {
        await s.close();
      }
    });

    it('stops the tool when the signal aborts during a dump', async () => {
      const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
      const ac = new AbortController();
      ac.abort();
      try {
        await expect(s.dump(join(workDir, `aborted-${flavor}.sql.gz`), { ...ctx(), signal: ac.signal })).rejects.toThrow(/cancel/i);
      } finally {
        await s.close();
      }
    });
  });

  describe('real recovery after a crash', () => {
    const targetId = (p: Profile) => ({ host: p.target.host, port: p.target.port, database: p.target.database });

    it('restores the backup when the journal is left behind and the target is gone', async () => {
      await createDb(local, 'crash_t', ['CREATE TABLE precious (id INT, v TEXT)', `INSERT INTO precious VALUES (1, 'keep me'), (2, 'and me')`]);
      const profile = profileFor('dev_app', 'crash_t');
      const { runner, paths, run } = createTestRunner(adapter, rootDir);
      expect((await run((cb) => runner.sync(profile, cb))).outcome.status).toBe('success');
      expect(await exists(paths.backupLatest(profile.id))).toBe(true);

      // The app died right after dropping the target.
      await writeJournal(paths, {
        profileId: profile.id, hadTarget: true, backupAvailable: true, startedAt: new Date().toISOString(), target: targetId(profile),
      });
      const t = await adapter.openTarget(profile.target);
      try { await t.dropDatabase(ctx()); } finally { await t.close(); }
      expect(await dbExists(local, 'crash_t')).toBe(false);

      const { outcome } = await run((cb) => runner.recover(profile, cb));
      expect(outcome).toMatchObject({ status: 'success', targetState: 'restored-from-backup' });
      expect(await select(local, 'crash_t', 'SELECT * FROM precious ORDER BY id')).toEqual([
        { id: 1, v: 'keep me' }, { id: 2, v: 'and me' },
      ]);
      expect(await exists(paths.journal(profile.id))).toBe(false);
    });

    it('removes a partial database when there was no target and no backup', async () => {
      await createDb(local, 'partial_t', ['CREATE TABLE half (id INT)']);
      const profile = profileFor('dev_app', 'partial_t');
      const { runner, paths, run } = createTestRunner(adapter, rootDir);
      await writeJournal(paths, {
        profileId: profile.id, hadTarget: false, backupAvailable: false, startedAt: new Date().toISOString(), target: targetId(profile),
      });
      const { outcome } = await run((cb) => runner.recover(profile, cb));
      expect(outcome).toMatchObject({ status: 'success', targetState: 'removed-partial' });
      expect(await dbExists(local, 'partial_t')).toBe(false);
    });
  });

  describe.runIf(flavor === 'mariadb')('MariaDB ed25519 authentication', () => {
    it('lets the bundled client sign in to a user IDENTIFIED VIA ed25519', async () => {
      await withClient(local, undefined, async (c) => {
        await c.query(`INSTALL SONAME 'auth_ed25519'`);
        await c.query(`CREATE USER 'edu'@'%' IDENTIFIED VIA ed25519 USING PASSWORD('ed-secret-pw')`);
        await c.query(`GRANT ALL PRIVILEGES ON *.* TO 'edu'@'%'`);
      });
      await createDb(local, 'ed_t', ['CREATE TABLE t (id INT)', 'INSERT INTO t VALUES (5)']);
      const ep: Endpoint = { host: local.host, port: local.port, user: 'edu', password: 'ed-secret-pw', database: 'ed_t' };
      const pluginDir = locate.pluginDir('mariadb');
      expect(pluginDir).not.toBeNull();

      await fs.mkdir(tmpRoot, { recursive: true });
      const cnf = join(tmpRoot, 'ed25519-check.cnf');
      await fs.writeFile(cnf, defaultsFileContent(ep));
      const out: string[] = [];
      try {
        await runTool({
          command: locate.path('mariadb', 'dump'),
          args: dumpArgs(ep, cnf, { flavor: 'mariadb', pluginDir }),
          signal: new AbortController().signal,
          secrets: [ep.password],
          onLine: (line) => out.push(line),
        });
      } finally {
        await fs.rm(cnf, { force: true });
      }
      // The dump goes to the tool's stdout, which runTool hands to onLine when no stdout stream is given.
      expect(out.join('\n')).toContain('CREATE TABLE `t`');
      expect(out.join('\n')).not.toContain('ed-secret-pw');
    });
  });
});
