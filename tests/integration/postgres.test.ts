import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, guardedQuery } from '../../src/main/engines/postgres/connection';
import { createPostgresAdapter } from '../../src/main/engines/postgres/postgres-adapter';
import { DropBlockedError, type EngineAdapter, type StepContext } from '../../src/main/engines/adapter';
import { writeJournal } from '../../src/main/sync/journal';
import { createToolLocator } from '../../src/main/tools/tool-locator';
import type { Endpoint, Profile, SyncEvent } from '../../src/shared/types';
import { BUNDLED_TOOLS, startTempServers, type TempServer } from './harness/temp-server';
import { createTestRunner, runSyncForTest } from './harness/sync-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const WEIRD_PASSWORD = `p@ss"w\\ord'1`;
const FIXTURE = join(import.meta.dirname, 'fixtures', 'postgres.sql');

let source: TempServer; // the "dev" server
let local: TempServer; // the "local" server
let trusting: TempServer; // a local server with an empty password
let workDir: string;
let rootDir: string; // the folder name has spaces and an accent on purpose
let adapter: EngineAdapter;
const clients: Client[] = [];

const connectTo = async (server: TempServer, database: string, password = server.password): Promise<Client> => {
  const client = new Client({
    host: server.host, port: server.port, user: server.user, password: () => password, database, ssl: false,
  });
  client.on('error', () => undefined);
  await client.connect();
  clients.push(client);
  return client;
};
const withClient = async <T>(server: TempServer, database: string, fn: (c: Client) => Promise<T>, password?: string) => {
  const client = await connectTo(server, database, password);
  try { return await fn(client); } finally { await client.end().catch(() => undefined); }
};
const createDb = (server: TempServer, name: string, sql?: string) =>
  withClient(server, 'postgres', async (c) => {
    await c.query(`CREATE DATABASE ${c.escapeIdentifier(name)}`);
    if (sql) await withClient(server, name, (d) => d.query(sql));
  });
const dbExists = (server: TempServer, name: string) =>
  withClient(server, 'postgres', async (c) => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1);
const databases = (server: TempServer) =>
  withClient(server, 'postgres', async (c) => (await c.query('SELECT datname FROM pg_database ORDER BY 1')).rows.map((r) => r.datname as string));

const endpoint = (server: TempServer, database: string, password = server.password): Endpoint =>
  ({ host: server.host, port: server.port, user: server.user, password, database });
let counter = 0;
const profileFor = (
  srcDb: string, tgtDb: string, over: { tgt?: TempServer; srcPassword?: string; tgtPassword?: string; backupEnabled?: boolean } = {},
): Profile => {
  const id = `p${++counter}`;
  return {
    id, name: id, engine: 'postgres', backupEnabled: over.backupEnabled ?? true,
    source: { ...endpoint(source, srcDb, over.srcPassword), ssl: false },
    target: endpoint(over.tgt ?? local, tgtDb, over.tgtPassword),
  };
};
const ctx = (): StepContext => ({ signal: new AbortController().signal, onLog: () => undefined, onProgress: () => undefined });
/** Compares the raw text of every event, not a JSON encoding that would escape quotes and backslashes. */
const expectNoSecret = (events: SyncEvent[], secret: string) => {
  const raw = events.map((e) => (e.type === 'log' ? e.line : e.type === 'progress' ? e.label : e.step));
  expect(raw.some((text) => text.includes(secret))).toBe(false);
};
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/** Everything the fixture creates, in a form two databases can be compared by. */
async function snapshot(server: TempServer, database: string, password?: string) {
  return withClient(server, database, async (c) => {
    const rows = async (sql: string) => (await c.query(sql)).rows;
    return {
      customers: await rows('SELECT * FROM customers ORDER BY id'),
      orders: await rows('SELECT * FROM orders ORDER BY id'),
      audit: await rows('SELECT * FROM audit ORDER BY id'),
      blobs: await rows('SELECT id, md5(data) AS hash, length(data) AS len FROM blobs ORDER BY id'),
      items: await rows('SELECT * FROM extra.items ORDER BY id'),
      view: await rows('SELECT * FROM order_totals ORDER BY name'),
      tables: await rows(`SELECT schemaname || '.' || tablename AS t FROM pg_tables
                           WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1`),
    };
  }, password);
}

beforeAll(async () => {
  [source, local, trusting] = await startTempServers(['postgres'], ['postgres'], ['postgres', { emptyPassword: true }]);
  workDir = await fs.mkdtemp(join(tmpdir(), 'dbsync-it-'));
  rootDir = join(workDir, 'dá ta sync');
  adapter = createPostgresAdapter({
    locate: createToolLocator(BUNDLED_TOOLS), tmpRoot: join(rootDir, 'tmp'),
  });
  const sql = await fs.readFile(FIXTURE, 'utf8');
  await createDb(source, 'dev_app', sql);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  await Promise.all([source, local, trusting].map((s) => s?.stop()));
  if (workDir) await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('PostgreSQL adapter', () => {
  it('copies schema and data exactly', async () => {
    await createDb(local, 'copy_t');
    const { outcome, events } = await runSyncForTest(adapter, profileFor('dev_app', 'copy_t'), rootDir);
    expect(outcome).toMatchObject({ status: 'success', targetState: 'replaced', warnings: [] });

    const want = await snapshot(source, 'dev_app');
    const got = await snapshot(local, 'copy_t');
    expect(got).toEqual(want);
    expect(got.customers[0].bio).toBe('Hello 😀 wörld — ünïcode ✓');
    expect(got.customers[1].bio).toContain('DEFINER=`root`@`%`');
    expect(got.blobs[0]).toMatchObject({ len: 256 });
    expect(got.audit.length).toBe(3);

    await withClient(local, 'copy_t', async (c) => {
      await c.query(`INSERT INTO orders (customer_id, total) VALUES (1, 1)`);
      expect((await c.query('SELECT count(*)::int AS n FROM audit')).rows[0].n).toBe(4); // trigger fires
      expect((await c.query('SELECT add_one(41) AS v')).rows[0].v).toBe(42); // function callable
      expect((await c.query(`SELECT nextval('ticket_seq')::int AS v`)).rows[0].v).toBe(42); // sequence continues
      expect((await c.query(`SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`)).rowCount).toBe(1);
    });
    expect(events.some((e) => e.type === 'progress' && e.percent === 100)).toBe(true);
  });

  it('overwrites existing target data', async () => {
    await createDb(local, 'over_t', 'CREATE TABLE local_only (id int); INSERT INTO local_only VALUES (1);');
    const { outcome } = await runSyncForTest(adapter, profileFor('dev_app', 'over_t'), rootDir);
    expect(outcome.status).toBe('success');
    const got = await snapshot(local, 'over_t');
    expect(got.tables.map((t) => t.t)).not.toContain('public.local_only');
    expect(got).toEqual(await snapshot(source, 'dev_app'));
  });

  it('takes a backup that restoreBackup brings back', async () => {
    await createDb(local, 'back_t', `CREATE TABLE precious (id int, v text); INSERT INTO precious VALUES (1, 'mine 😀');`);
    const profile = profileFor('dev_app', 'back_t');
    const { runner, paths, run } = createTestRunner(adapter, rootDir);

    expect((await run((cb) => runner.sync(profile, cb))).outcome.status).toBe('success');
    expect(await exists(paths.backupLatest(profile.id))).toBe(true);
    expect((await snapshot(local, 'back_t')).tables.map((t) => t.t)).not.toContain('public.precious');

    const { outcome } = await run((cb) => runner.restoreBackup(profile, cb));
    expect(outcome).toMatchObject({ status: 'success', targetState: 'restored-from-backup' });
    await withClient(local, 'back_t', async (c) => {
      expect((await c.query('SELECT * FROM precious')).rows).toEqual([{ id: 1, v: 'mine 😀' }]);
      expect((await c.query(`SELECT to_regclass('public.customers') AS t`)).rows[0].t).toBeNull();
    });
  });

  it('works with database name "order-db test" and password p@ss"w\\ord\'1', async () => {
    const name = 'order-db test';
    const alter = async (server: TempServer, from: string, to: string) =>
      withClient(server, 'postgres', (c) => c.query(`ALTER ROLE ${c.escapeIdentifier(server.user)} PASSWORD ${c.escapeLiteral(to)}`), from);
    await createDb(source, name, 'CREATE TABLE t (id int); INSERT INTO t VALUES (7);');
    await createDb(local, name, 'CREATE TABLE old (id int);');
    await alter(source, source.password, WEIRD_PASSWORD);
    await alter(local, local.password, WEIRD_PASSWORD);
    try {
      const profile = profileFor(name, name, { srcPassword: WEIRD_PASSWORD, tgtPassword: WEIRD_PASSWORD });
      const { outcome, events } = await runSyncForTest(adapter, profile, rootDir);
      expect(outcome.status).toBe('success');
      expectNoSecret(events, WEIRD_PASSWORD);
      const rows = await withClient(local, name, async (c) => (await c.query('SELECT id FROM t')).rows, WEIRD_PASSWORD);
      expect(rows).toEqual([{ id: 7 }]);
    } finally {
      await alter(source, WEIRD_PASSWORD, source.password);
      await alter(local, WEIRD_PASSWORD, local.password);
    }
  });

  it('works when the target server has an empty password', async () => {
    await createDb(trusting, 'empty_pw_t', 'CREATE TABLE gone (id int);');
    const { outcome } = await runSyncForTest(adapter, profileFor('dev_app', 'empty_pw_t', { tgt: trusting }), rootDir);
    expect(outcome.status).toBe('success');
    expect(await snapshot(trusting, 'empty_pw_t')).toEqual(await snapshot(source, 'dev_app'));
  });

  it('ignores inherited PGHOST and PGPASSWORD', async () => {
    const bogus = {
      PGHOST: 'bogus.invalid', PGPORT: '1', PGUSER: 'nobody', PGPASSWORD: 'bogus-password', PGDATABASE: 'nope',
      PGSSLMODE: 'verify-full', PGOPTIONS: '-c bogus=1',
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
    await createDb(local, 'empty_t', 'CREATE TABLE old (id int);');
    const { outcome } = await runSyncForTest(adapter, profileFor('empty_src', 'empty_t'), rootDir);
    expect(outcome).toMatchObject({ status: 'success', warnings: [] });
    const t = await withClient(local, 'empty_t', async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`)).rows[0].n);
    expect(t).toBe(0);
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
    const counts = () => withClient(source, 'dev_app', async (c) => {
      const out: Record<string, number> = {};
      for (const t of ['customers', 'orders', 'audit', 'blobs', 'extra.items']) {
        out[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      }
      const tables = (await c.query(`SELECT schemaname || '.' || tablename AS t FROM pg_tables
                                       WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1`)).rows;
      const seq = (await c.query(`SELECT last_value::int AS v FROM ticket_seq`)).rows[0].v;
      return { out, tables, seq, dbs: await databases(source) };
    });
    const before = await counts();
    await createDb(local, 'ro_t');
    expect((await runSyncForTest(adapter, profileFor('dev_app', 'ro_t'), rootDir)).outcome.status).toBe('success');
    expect(await counts()).toEqual(before);
  });

  it('engineChecks finds no issues between two servers with the same extensions', async () => {
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

  it('forces connected clients off the target and drops it', async () => {
    await createDb(local, 'busy_t', 'CREATE TABLE old (id int);');
    const squatter = await connectTo(local, 'busy_t');
    await squatter.query('SELECT 1');
    const { outcome } = await runSyncForTest(adapter, profileFor('dev_app', 'busy_t'), rootDir);
    expect(outcome.status).toBe('success');
    expect((await snapshot(local, 'busy_t')).customers.length).toBe(2);
  });

  it('recovers the old data when the restore fails', async () => {
    await createDb(local, 'fail_t', `CREATE TABLE precious (id int); INSERT INTO precious VALUES (1), (2);`);
    // Corrupts the sync's dump on the first restore, then uses the real restore, including for recovery.
    let corrupted = false;
    const faulty: EngineAdapter = {
      openSource: (e) => adapter.openSource(e),
      engineChecks: (s, t) => adapter.engineChecks(s, t),
      async openTarget(e) {
        const real = await adapter.openTarget(e);
        return {
          ...real,
          async restore(dumpPath, c) {
            if (!corrupted) {
              corrupted = true;
              await fs.writeFile(join(dumpPath, 'toc.dat'), 'not a dump');
            }
            return real.restore(dumpPath, c);
          },
        };
      },
    };
    const profile = profileFor('dev_app', 'fail_t');
    const { runner, paths, run } = createTestRunner(faulty, rootDir);
    const { outcome } = await run((cb) => runner.sync(profile, cb));
    expect(outcome).toMatchObject({ status: 'failed', step: 'replace', targetState: 'restored-from-backup' });
    expect(corrupted).toBe(true);
    await withClient(local, 'fail_t', async (c) => {
      expect((await c.query('SELECT id FROM precious ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
    });
    expect(await exists(paths.journal(profile.id))).toBe(false);
  });

  it('reports server info with minor 0 and a readable system identifier or null', async () => {
    const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
    const t = await adapter.openTarget(endpoint(local, 'not_made_yet'));
    try {
      for (const info of [await s.info(), await t.info()]) {
        expect(info.flavor).toBe('postgres');
        expect(info.version[0]).toBe(18);
        expect(info.version[1]).toBe(0);
        expect(info.identity === null || /^\d+$/.test(info.identity)).toBe(true);
      }
      expect((await s.info()).identity).not.toBe((await t.info()).identity);
    } finally {
      await s.close();
      await t.close();
    }
  });
});

describe('contracts the sync runner relies on', () => {
  it('opens a target whose database does not exist', async () => {
    const t = await adapter.openTarget(endpoint(local, 'never_created'));
    try {
      expect(await t.exists()).toBe(false);
      expect(await t.sizeBytes()).toBe(0);
      expect(await t.listTables()).toEqual([]);
      expect(await t.canCreateDatabase()).toBe(true);
      expect((await t.info()).version[0]).toBe(18);
    } finally {
      await t.close();
    }
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
    } finally {
      await t.close();
    }
    expect(await databases(local)).toEqual(before.filter((d) => d !== 'drop_me'));
  });
});

describe('limits and refusals', () => {
  it('reports a drop the role may not do as blocked, deletes nothing and leaves the target untouched', async () => {
    await withClient(local, 'postgres', (c) => c.query(`CREATE ROLE limited LOGIN CREATEDB PASSWORD 'limited-pw'`));
    const limitedServer: TempServer = { ...local, user: 'limited', password: 'limited-pw' };
    await createDb(local, 'guarded_t', 'CREATE TABLE keep (id int); INSERT INTO keep VALUES (1), (2);');
    const squatter = await connectTo(local, 'guarded_t'); // another role's session the limited role cannot end
    await squatter.query('SELECT 1');

    // What the server really answers to the limited role.
    const limited = await connectTo(limitedServer, 'postgres');
    const refused = await limited.query('DROP DATABASE guarded_t WITH (FORCE)').catch((e: unknown) => e as { code?: string });
    expect((refused as { code?: string }).code).toBe('42501');

    const t = await adapter.openTarget(endpoint(limitedServer, 'guarded_t'));
    try {
      await expect(t.dropDatabase(ctx())).rejects.toBeInstanceOf(DropBlockedError);
    } finally {
      await t.close();
    }

    const profile = profileFor('dev_app', 'guarded_t', { backupEnabled: false });
    profile.target = endpoint(limitedServer, 'guarded_t');
    const { outcome } = await runSyncForTest(adapter, profile, rootDir);
    expect(outcome).toMatchObject({ status: 'failed', step: 'replace', targetState: 'untouched' });
    await withClient(local, 'guarded_t', async (c) => {
      expect((await c.query('SELECT id FROM keep ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
    });
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
    const client = await connect(endpoint(local, 'postgres'), 'postgres', false);
    clients.push(client);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    await expect(guardedQuery(client, 'SELECT pg_sleep(60)', [], { signal: ac.signal })).rejects.toThrow(/cancel/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('gives up on a slow query at the deadline', async () => {
    const client = await connect(endpoint(local, 'postgres'), 'postgres', false);
    clients.push(client);
    const started = Date.now();
    await expect(guardedQuery(client, 'SELECT pg_sleep(60)', [], { timeoutMs: 300 })).rejects.toThrow(/did not answer/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('dumps into a folder that already has files in it', async () => {
    const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
    const dest = join(workDir, 'leftover.dump');
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(join(dest, 'stale.txt'), 'left by a crash');
    try {
      await s.dump(dest, ctx());
    } finally {
      await s.close();
    }
    expect(await exists(join(dest, 'toc.dat'))).toBe(true);
    expect(await exists(join(dest, 'stale.txt'))).toBe(false);
  });

  it("does not list another session's temporary tables", async () => {
    const holder = await connectTo(source, 'dev_app');
    await holder.query('CREATE TEMP TABLE tmp_probe (id int)');
    const seenRaw = await withClient(source, 'dev_app', async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'tmp_probe'`)).rows[0].n);
    expect(seenRaw).toBe(1); // the server does show it, so the filter is what hides it
    const s = await adapter.openSource({ ...endpoint(source, 'dev_app'), ssl: false });
    try {
      const tables = await s.listTables();
      expect(tables.filter((t) => /tmp_probe|pg_temp/.test(t))).toEqual([]);
      expect(tables).toContain('public.customers');
    } finally {
      await s.close();
    }
    await holder.end();
  });

  it('keeps passwords out of the events and failure text of a failed sync', async () => {
    const profile = profileFor('dev_app', 'wrong_pw_t', { srcPassword: WEIRD_PASSWORD });
    const { outcome, events } = await runSyncForTest(adapter, profile, rootDir);
    expect(outcome.status).toBe('failed');
    const text = outcome.status === 'failed' ? [outcome.message, outcome.details] : [];
    expect(text.some((t) => t.includes(WEIRD_PASSWORD))).toBe(false);
    expectNoSecret(events, WEIRD_PASSWORD);
  });
});

describe('real recovery after a crash', () => {
  const targetId = (p: Profile) => ({ host: p.target.host, port: p.target.port, database: p.target.database });

  it('restores the backup when the journal is left behind and the target is gone', async () => {
    await createDb(local, 'crash_t', `CREATE TABLE precious (id int, v text); INSERT INTO precious VALUES (1, 'keep me'), (2, 'and me');`);
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
    await withClient(local, 'crash_t', async (c) => {
      expect((await c.query('SELECT * FROM precious ORDER BY id')).rows).toEqual([{ id: 1, v: 'keep me' }, { id: 2, v: 'and me' }]);
    });
    expect(await exists(paths.journal(profile.id))).toBe(false);
  });

  it('removes a partial database when there was no target and no backup', async () => {
    await createDb(local, 'partial_t', 'CREATE TABLE half (id int);');
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
