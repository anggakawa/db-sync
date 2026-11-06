// Which servers the bundled tools (PostgreSQL 18, MySQL 9.7, MariaDB 12.3) can copy between. The "-old" servers are the
// previous lines a real dev server is likely to run: PostgreSQL 14, MySQL 8.0, MariaDB 10.11. Every server here is started by
// the test on 127.0.0.1; nothing else is ever connected to.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Connection } from 'mysql2/promise';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMysqlAdapter } from '../../src/main/engines/mysql/mysql-adapter';
import { dumpArgs } from '../../src/main/engines/mysql/args';
import { createPostgresAdapter } from '../../src/main/engines/postgres/postgres-adapter';
import type { EngineAdapter } from '../../src/main/engines/adapter';
import { createToolLocator } from '../../src/main/tools/tool-locator';
import type { Endpoint, Engine, Profile, SyncOutcome } from '../../src/shared/types';
import { BUNDLED_TOOLS, startTempServers, type ServerName, type TempServer } from './harness/temp-server';
import { runSyncForTest } from './harness/sync-fixture';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 400_000 });

const FIXTURES = join(import.meta.dirname, 'fixtures');
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let workDir: string;
let rootDir: string; // the folder name has spaces and an accent on purpose
let counter = 0;

beforeAll(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'dbsync-compat-'));
  rootDir = join(workDir, 'dá ta sync');
});
afterAll(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const endpoint = (server: TempServer, database: string, user = server.user, password = server.password): Endpoint =>
  ({ host: server.host, port: server.port, user, password, database });
const profile = (engine: Engine, src: Endpoint, tgt: Endpoint): Profile => {
  const id = `c${++counter}`;
  return { id, name: id, engine, backupEnabled: true, source: { ...src, ssl: false }, target: tgt };
};

/** What a failed outcome said, so a failing assertion shows the tool's own words. */
const why = (o: SyncOutcome): string => (o.status === 'failed' ? `${o.message}
${o.details}` : o.status);

/** "Ends cleanly": a finished copy, or a failure that put the previous local data back and says why. */
function expectCleanEnd(outcome: SyncOutcome) {
  if (outcome.status === 'success') {
    expect(outcome, why(outcome)).toMatchObject({ targetState: 'replaced' });
    return 'success' as const;
  }
  expect(outcome, why(outcome)).toMatchObject({ status: 'failed', targetState: 'restored-from-backup' });
  if (outcome.status === 'failed') expect(`${outcome.message}\n${outcome.details}`).toMatch(/can't load this dump from dev/);
  return 'restored' as const;
}

// ---------------------------------------------------------------- PostgreSQL

describe('PostgreSQL 14 and 18', () => {
  let pg: TempServer[]; // pg[0], pg[1]: version 18; pg[2], pg[3]: version 14
  let adapter: EngineAdapter;
  const clients: Client[] = [];

  const withClient = async <T>(server: TempServer, database: string, fn: (c: Client) => Promise<T>): Promise<T> => {
    const client = new Client({ host: server.host, port: server.port, user: server.user, password: () => server.password, database, ssl: false });
    client.on('error', () => undefined);
    await client.connect();
    clients.push(client);
    try { return await fn(client); } finally { await client.end().catch(() => undefined); }
  };
  const createDb = (server: TempServer, name: string, sql?: string) =>
    withClient(server, 'postgres', async (c) => { await c.query(`CREATE DATABASE ${c.escapeIdentifier(name)}`); })
      .then(() => (sql ? withClient(server, name, (d) => d.query(sql)) : undefined));
  const snapshot = (server: TempServer, database: string) => withClient(server, database, async (c) => {
    const rows = async (sql: string) => (await c.query(sql)).rows;
    return {
      customers: await rows('SELECT * FROM customers ORDER BY id'),
      orders: await rows('SELECT * FROM orders ORDER BY id'),
      audit: await rows('SELECT * FROM audit ORDER BY id'),
      blobs: await rows('SELECT id, md5(data) AS hash, length(data) AS len FROM blobs ORDER BY id'),
      items: await rows('SELECT * FROM extra.items ORDER BY id'),
      view: await rows('SELECT * FROM order_totals ORDER BY name'),
      tables: await rows(`SELECT schemaname || '.' || tablename AS t FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1`),
    };
  });

  beforeAll(async () => {
    pg = await startTempServers(['postgres'], ['postgres'], ['postgres-old'], ['postgres-old']);
    adapter = createPostgresAdapter({ locate: createToolLocator(BUNDLED_TOOLS), tmpRoot: join(rootDir, 'tmp') });
    const sql = await fs.readFile(join(FIXTURES, 'postgres.sql'), 'utf8');
    await createDb(pg[0], 'dev_app', sql);
    await createDb(pg[2], 'dev_app', sql);
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
    await Promise.all((pg ?? []).map((s) => s.stop()));
  });

  const sync = (src: TempServer, tgt: TempServer, tgtDb: string) =>
    runSyncForTest(adapter, profile('postgres', endpoint(src, 'dev_app'), endpoint(tgt, tgtDb)), rootDir);

  it('postgres-old source to postgres-old target succeeds using bundled tools', async () => {
    await createDb(pg[3], 'old_old');
    const { outcome } = await sync(pg[2], pg[3], 'old_old');
    expect(outcome, why(outcome)).toMatchObject({ status: 'success', targetState: 'replaced', warnings: [] });
    expect(await snapshot(pg[3], 'old_old')).toEqual(await snapshot(pg[2], 'dev_app'));
    await withClient(pg[3], 'old_old', async (c) => {
      await c.query('INSERT INTO orders (customer_id, total) VALUES (1, 1)');
      expect((await c.query('SELECT count(*)::int AS n FROM audit')).rows[0].n).toBe(4); // trigger fires
      expect((await c.query('SELECT add_one(41) AS v')).rows[0].v).toBe(42);
    });
  });

  it('postgres-old source to postgres target succeeds', async () => {
    await createDb(pg[1], 'old_new');
    const { outcome } = await sync(pg[2], pg[1], 'old_new');
    expect(outcome, why(outcome)).toMatchObject({ status: 'success', targetState: 'replaced' });
    expect(await snapshot(pg[1], 'old_new')).toEqual(await snapshot(pg[2], 'dev_app'));
  });

  it('postgres source to postgres-old target ends cleanly', async () => {
    await createDb(pg[3], 'new_old', `CREATE TABLE precious (id int, v text); INSERT INTO precious VALUES (1, 'mine');`);
    const { outcome } = await sync(pg[0], pg[3], 'new_old');
    const result = expectCleanEnd(outcome);
    if (result === 'success') {
      expect(await snapshot(pg[3], 'new_old')).toEqual(await snapshot(pg[0], 'dev_app'));
    } else {
      const left = await withClient(pg[3], 'new_old', async (c) => ({
        precious: (await c.query('SELECT * FROM precious')).rows,
        copied: (await c.query(`SELECT to_regclass('public.customers') AS t`)).rows[0].t,
      }));
      expect(left).toEqual({ precious: [{ id: 1, v: 'mine' }], copied: null });
    }
    console.log(`[compat] postgres 18 -> postgres 14: ${result}${outcome.status === 'failed' ? `: ${outcome.message} | ${outcome.details}` : ''}`);
  });
});

// ---------------------------------------------------------------- MySQL and MariaDB

const FAMILIES = [
  { flavor: 'mysql', current: 'mysql', old: 'mysql-old' },
  { flavor: 'mariadb', current: 'mariadb', old: 'mariadb-old' },
] as const satisfies ReadonlyArray<{ flavor: string; current: ServerName; old: ServerName }>;

describe.each(FAMILIES)('$flavor current and previous line', ({ flavor, old }) => {
  let servers: TempServer[]; // [0] current dev, [1] current local, [2] old dev, [3] old local
  let adapter: EngineAdapter;
  const conns: Connection[] = [];

  const connectTo = async (server: TempServer, database?: string, user = server.user, password = server.password) => {
    const c = await mysql.createConnection({ host: server.host, port: server.port, user, password, database });
    c.on('error', () => undefined);
    conns.push(c);
    return c;
  };
  const withClient = async <T>(server: TempServer, database: string | undefined, fn: (c: Connection) => Promise<T>, user?: string, password?: string) => {
    const c = await connectTo(server, database, user, password);
    try { return await fn(c); } finally { await c.end().catch(() => undefined); }
  };
  const rows = async (c: Connection, sql: string) => (await c.query(sql))[0] as Row[];
  const createDb = (server: TempServer, name: string, statements: string[] = []) =>
    withClient(server, undefined, async (c) => {
      await c.query(`CREATE DATABASE ${mysql.escapeId(name)}`);
      await c.query(`USE ${mysql.escapeId(name)}`);
      for (const sql of statements) await c.query(sql);
    });
  const select = (server: TempServer, database: string, sql: string) => withClient(server, database, (c) => rows(c, sql));
  const databases = (server: TempServer) =>
    withClient(server, undefined, async (c) => (await rows(c, 'SHOW DATABASES')).map((r) => String(r.Database)));

  /** Everything the fixture creates, in a form two databases can be compared by. */
  const snapshot = (server: TempServer, database: string) => withClient(server, database, async (c) => ({
    customers: await rows(c, 'SELECT * FROM customers ORDER BY id'),
    orders: await rows(c, 'SELECT * FROM orders ORDER BY id'),
    audit: await rows(c, 'SELECT * FROM audit ORDER BY id'),
    blobs: await rows(c, 'SELECT id, SHA2(data, 256) AS hash, LENGTH(data) AS len FROM blobs ORDER BY id'),
    view: await rows(c, 'SELECT * FROM order_totals ORDER BY name'),
    notes: await rows(c, 'SELECT * FROM notes ORDER BY id'),
    notesTable: (await rows(c, 'SHOW CREATE TABLE notes'))[0]['Create Table'],
    noteRoutine: await rows(c, `SELECT routine_name AS n, routine_definition AS body FROM information_schema.routines WHERE routine_schema = DATABASE() AND routine_name = 'note_text'`),
    tables: await rows(c, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1'),
    collation: await rows(c, `SELECT default_collation_name AS c FROM information_schema.schemata WHERE schema_name = DATABASE()`),
    events: (await rows(c, `SELECT event_name AS n FROM information_schema.events WHERE event_schema = DATABASE() ORDER BY 1`)).map((r) => r.n),
  }));

  const sync = (src: TempServer, tgt: TempServer, tgtDb: string, srcUser?: { user: string; password: string }, tgtUser?: { user: string; password: string }) =>
    runSyncForTest(adapter, profile('mysql',
      endpoint(src, 'dev_app', srcUser?.user, srcUser?.password), endpoint(tgt, tgtDb, tgtUser?.user, tgtUser?.password)), rootDir);

  /** A finished copy matches its source exactly, including what the fixture checks for routines, triggers and events. */
  async function expectCopied(src: TempServer, tgt: TempServer, db: string) {
    const want = await snapshot(src, 'dev_app');
    const got = await snapshot(tgt, db);
    expect(got).toEqual(want);
    expect(got.customers[0].bio).toBe('Hello 😀 wörld — ünïcode ✓');
    expect(got.collation).toEqual([{ c: 'utf8mb4_unicode_ci' }]);
    expect(got.audit.length).toBe(3);
    await withClient(tgt, db, async (c) => {
      await c.query('INSERT INTO orders (customer_id, total) VALUES (1, 1)');
      expect((await rows(c, 'SELECT COUNT(*) AS n FROM audit'))[0].n).toBe(4); // the trigger fires
      expect((await rows(c, 'SELECT add_one(41) AS v'))[0].v).toBe(42);
      expect((await rows(c, 'SELECT total FROM order_totals WHERE name = "Bob"'))[0].total).toBe('99.99');
    });
  }

  beforeAll(async () => {
    servers = await startTempServers([flavor], [flavor], [old], [old]);
    adapter = createMysqlAdapter({ locate: createToolLocator(BUNDLED_TOOLS), tmpRoot: join(rootDir, 'tmp') });
    const fixture = (await fs.readFile(join(FIXTURES, 'mysql.sql'), 'utf8')).split(/\r?\n-- split\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const dev of [servers[0], servers[2]]) {
      await withClient(dev, undefined, async (c) => {
        await c.query(`CREATE USER 'dev_owner'@'%' IDENTIFIED BY 'dev-owner-pw'`);
        await c.query('GRANT ALL PRIVILEGES ON *.* TO `dev_owner`@`%`');
        await c.query('CREATE DATABASE dev_app');
        await c.query('USE dev_app');
        for (const sql of fixture) await c.query(sql);
        // An event whose body contains ;; makes MySQL's mysqldump spin forever (a bug in that tool), so only MariaDB gets one.
        if (flavor === 'mariadb') {
          await c.query("CREATE DEFINER=`dev_owner`@`%` EVENT semicolons_in_body ON SCHEDULE EVERY 1 DAY STARTS '2035-01-01 00:00:00' DO SET @x = ';;'");
        }
      });
    }
  });
  afterAll(async () => {
    await Promise.all(conns.map((c) => c.end().catch(() => undefined)));
    await Promise.all((servers ?? []).map((s) => s.stop()));
  });

  it(`${old} source to ${old} target succeeds using bundled tools`, async () => {
    await createDb(servers[3], 'old_old');
    const { outcome } = await sync(servers[2], servers[3], 'old_old');
    expect(outcome, why(outcome)).toMatchObject({ status: 'success', targetState: 'replaced', warnings: [] });
    await expectCopied(servers[2], servers[3], 'old_old');
  });

  it(`${old} source to ${flavor} target succeeds`, async () => {
    await createDb(servers[1], 'old_new');
    const { outcome } = await sync(servers[2], servers[1], 'old_new');
    expect(outcome, why(outcome)).toMatchObject({ status: 'success', targetState: 'replaced' });
    await expectCopied(servers[2], servers[1], 'old_new');
  });

  it(`${flavor} source to ${old} target ends cleanly`, async () => {
    await createDb(servers[3], 'new_old', ['CREATE TABLE precious (id INT, v TEXT)', `INSERT INTO precious VALUES (1, 'mine')`]);
    const { outcome } = await sync(servers[0], servers[3], 'new_old');
    const result = expectCleanEnd(outcome);
    if (result === 'success') {
      await expectCopied(servers[0], servers[3], 'new_old');
    } else {
      expect(await select(servers[3], 'new_old', 'SELECT * FROM precious')).toEqual([{ id: 1, v: 'mine' }]);
      expect(await select(servers[3], 'new_old', `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'new_old' AND table_name = 'customers'`))
        .toEqual([{ n: 0 }]);
    }
    console.log(`[compat] ${flavor} current -> ${old}: ${result}${outcome.status === 'failed' ? `: ${outcome.message} | ${outcome.details}` : ''}`);
  });

  if (flavor === 'mysql') {
    it('mysqldump works against the bundled mysql server without --column-statistics changes', async () => {
      const args = dumpArgs(endpoint(servers[0], 'dev_app'), 'defaults.cnf', { flavor: 'mysql' });
      expect(args.filter((a) => a.startsWith('--column-statistics'))).toEqual([]);
      await createDb(servers[1], 'colstats');
      expect((await sync(servers[0], servers[1], 'colstats')).outcome).toMatchObject({ status: 'success', targetState: 'replaced' });
      expect(await databases(servers[1])).toContain('colstats');
      await expectCopied(servers[0], servers[1], 'colstats');
    });

    it('a mysql_native_password account works as source and target through mysql2 and the bundled tools', async () => {
      const native = { user: 'native_user', password: 'nat1ve-pw' };
      for (const server of [servers[2], servers[3]]) {
        await withClient(server, undefined, async (c) => {
          await c.query(`CREATE USER ${mysql.escape(native.user)}@'%' IDENTIFIED WITH mysql_native_password BY ${mysql.escape(native.password)}`);
          await c.query(`GRANT ALL PRIVILEGES ON *.* TO ${mysql.escape(native.user)}@'%'`);
          expect((await rows(c, `SELECT plugin FROM mysql.user WHERE user = ${mysql.escape(native.user)}`))[0].plugin).toBe('mysql_native_password');
        });
        await withClient(server, undefined, async (c) => {
          expect((await rows(c, 'SELECT CURRENT_USER() AS u'))[0].u).toBe(`${native.user}@%`);
        }, native.user, native.password);
      }
      await createDb(servers[3], 'native_t');
      const { outcome } = await sync(servers[2], servers[3], 'native_t', native, native);
      expect(outcome, why(outcome)).toMatchObject({ status: 'success', targetState: 'replaced' });
      await expectCopied(servers[2], servers[3], 'native_t');
    });
  }

  if (flavor === 'mariadb') {
    it('a mysql_native_password account works as source and target through mysql2 and the bundled tools', async () => {
      const native = { user: 'native_user', password: 'nat1ve-pw' };
      for (const server of [servers[2], servers[3]]) {
        await withClient(server, undefined, async (c) => {
          await c.query(`CREATE USER ${mysql.escape(native.user)}@'%' IDENTIFIED VIA mysql_native_password USING PASSWORD(${mysql.escape(native.password)})`);
          await c.query(`GRANT ALL PRIVILEGES ON *.* TO ${mysql.escape(native.user)}@'%'`);
        });
        await withClient(server, undefined, async (c) => {
          expect((await rows(c, 'SELECT CURRENT_USER() AS u'))[0].u).toBe(`${native.user}@%`);
        }, native.user, native.password);
      }
      await createDb(servers[3], 'native_t');
      const { outcome } = await sync(servers[2], servers[3], 'native_t', native, native);
      expect(outcome, why(outcome)).toMatchObject({ status: 'success', targetState: 'replaced' });
      await expectCopied(servers[2], servers[3], 'native_t');
    });
  }
});
