import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Transform, pipeline as pipelineWithCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import mysql, { type Connection } from 'mysql2/promise';
import type { CheckIssue, Endpoint, SourceEndpoint } from '../../../shared/types';
import { runTool } from '../../process/process-runner';
import type { ToolLocator } from '../../tools/tool-locator';
import {
  DropBlockedError, type CreateOptions, type EngineAdapter, type ServerInfo, type SourceDatabase, type StepContext,
  type TargetDatabase,
} from '../adapter';
import { DDL_TIMEOUT_MS, requireEndpoint } from '../limits';
import { defaultsFileContent, dumpArgs, parseServerVersion, restoreArgs, type MysqlFlavor } from './args';
import {
  connect, endQuietly, ER_DBACCESS_DENIED, ER_LOCK_WAIT_TIMEOUT, ER_SPECIFIC_ACCESS_DENIED, ER_TABLEACCESS_DENIED, errnoOf,
  guardedQuery as q,
} from './connection';
import { createDefinerFilter } from './definer-filter';

/** Seconds a DROP DATABASE waits for a metadata lock before it gives up. */
const LOCK_WAIT_SECONDS = 30;
/** Errors that mean the DROP was refused. Nothing is deleted in any of them. */
const DROP_REFUSED = new Set([ER_LOCK_WAIT_TIMEOUT, ER_DBACCESS_DENIED, ER_SPECIFIC_ACCESS_DENIED, ER_TABLEACCESS_DENIED]);
const NAME_PART = /^[A-Za-z0-9_]+$/;

/** Beyond the adapter interface: what engineChecks needs from the source. */
interface MysqlSource extends SourceDatabase { nonInnoDbTables(): Promise<Array<{ name: string; engine: string }>> }

type Row = Record<string, unknown>;

async function readVersion(conn: Connection) {
  const rows = await q<Row[]>(conn, 'SELECT VERSION() AS v');
  return parseServerVersion(String(rows[0].v));
}

async function readInfo(conn: Connection): Promise<ServerInfo> {
  const parsed = await readVersion(conn);
  let identity: string | null = null;
  if (parsed.flavor === 'mysql') {
    try {
      identity = String((await q<Row[]>(conn, 'SELECT @@server_uuid AS id'))[0]?.id ?? '') || null;
    } catch { /* no permission */ }
  }
  return { ...parsed, identity };
}

async function readTables(conn: Connection, database: string): Promise<string[]> {
  const rows = await q<Row[]>(
    conn,
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
    [database],
  );
  // Sorted here, not by the server, so two servers with different collations agree.
  return rows.map((r) => String(r.name)).sort();
}

async function readSize(conn: Connection, database: string): Promise<number> {
  const rows = await q<Row[]>(
    conn,
    'SELECT COALESCE(SUM(data_length + index_length), 0) AS size FROM information_schema.tables WHERE table_schema = ?',
    [database],
  );
  return Number(rows[0]?.size ?? 0);
}

async function readCreateOptions(conn: Connection, database: string): Promise<CreateOptions> {
  const rows = await q<Row[]>(
    conn,
    `SELECT default_character_set_name AS charset, default_collation_name AS collation
       FROM information_schema.schemata WHERE schema_name = ?`,
    [database],
  );
  return rows[0] ? { charset: String(rows[0].charset), collation: String(rows[0].collation) } : {};
}

/** True when the server treats database names as case-insensitive (lower_case_table_names is not 0). */
async function readFoldsCase(conn: Connection): Promise<boolean> {
  const rows = await q<Row[]>(conn, 'SELECT @@lower_case_table_names AS v');
  return Number(rows[0]?.v) !== 0;
}

const identifier = (value: string, what: string): string => {
  if (!NAME_PART.test(value)) throw new Error(`Unexpected ${what} name: ${value}`);
  return value;
};

export function createMysqlAdapter(deps: {
  locate: ToolLocator; tmpRoot: string;
  killClients?: (database: string) => Promise<void>; // test seam; the default kills from the process list
}): EngineAdapter {
  /**
   * Runs `fn` with a defaults file holding the credentials. The file is removed on every path.
   * The tool is given the bare file name and runs in the folder that holds it: mysql.exe cannot open a defaults file
   * whose full path has non-ASCII characters (a user name with an accent), but a plain name always works.
   */
  async function withDefaultsFile<T>(ep: Endpoint, ctx: StepContext, fn: (name: string) => Promise<T>): Promise<T> {
    await fs.mkdir(deps.tmpRoot, { recursive: true });
    const name = `client-${randomBytes(8).toString('hex')}.cnf`;
    const file = join(deps.tmpRoot, name);
    try {
      await fs.writeFile(file, defaultsFileContent(ep), { mode: 0o600, flag: 'wx' });
      return await fn(name);
    } finally {
      await fs.rm(file, { force: true, maxRetries: 3, retryDelay: 100 }).catch((err: unknown) =>
        ctx.onLog(`Could not remove ${file}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  const toolOptions = (flavor: MysqlFlavor, ssl?: boolean) => ({ flavor, ssl, pluginDir: deps.locate.pluginDir(flavor) });

  /** A callback for a stream's byte count that reports whole percents only when they change. */
  function percentReporter(total: number, label: string, ctx: StepContext): (bytes: number) => void {
    let last = -1;
    return (bytes) => {
      const percent = total > 0 ? Math.min(99, Math.floor((bytes / total) * 100)) : null;
      if (percent === last) return;
      last = percent ?? -1;
      ctx.onProgress(label, percent);
    };
  }

  /** tool stdout, then the definer filter, then gzip, then the file. */
  async function runDump(conn: Connection, ep: Endpoint, ssl: boolean | undefined, dest: string, label: string, ctx: StepContext) {
    // A crash can leave a file (or, from another engine, a folder) behind.
    await fs.rm(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    const { flavor } = await readVersion(conn);
    const report = percentReporter(await readSize(conn, ep.database), label, ctx);
    await withDefaultsFile(ep, ctx, async (defaultsFile) => {
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; report(bytes); callback(null, chunk); },
      });
      const written = pipeline(counter, createDefinerFilter(), createGzip(), createWriteStream(dest));
      written.catch(() => undefined); // the tool's own failure is the one to report
      try {
        await runTool({
          command: deps.locate.path(flavor, 'dump'),
          args: dumpArgs(ep, defaultsFile, toolOptions(flavor, ssl)),
          cwd: deps.tmpRoot,
          signal: ctx.signal,
          secrets: [ep.password],
          stdout: counter,
          onLine: ctx.onLog,
        });
      } catch (err) {
        counter.destroy();
        await written.catch(() => undefined);
        throw err;
      }
      await written;
      ctx.onProgress(label, 100);
    });
  }

  /** The file, gunzipped, into the client's stdin. The client stops at the first error. */
  async function runRestore(conn: Connection, ep: Endpoint, dumpPath: string, ctx: StepContext) {
    const { flavor } = await readVersion(conn);
    const { size } = await fs.stat(dumpPath);
    const report = percentReporter(size, 'Restoring local data', ctx);
    await withDefaultsFile(ep, ctx, async (defaultsFile) => {
      let read = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) { read += chunk.length; report(read); callback(null, chunk); },
      });
      const stdin = pipelineWithCallback(createReadStream(dumpPath), counter, createGunzip(), new PassThrough(), () => undefined);
      try {
        await runTool({
          command: deps.locate.path(flavor, 'restore'),
          args: restoreArgs(ep, defaultsFile, toolOptions(flavor)),
          cwd: deps.tmpRoot,
          signal: ctx.signal,
          secrets: [ep.password],
          stdin,
          onLine: ctx.onLog,
        });
      } finally {
        stdin.destroy(); // closes the dump file even when the client stopped early
      }
      ctx.onProgress('Restoring local data', 100);
    });
  }

  /** The reads that both sides share, and whether the server folds database names. */
  function readerFor(conn: Connection, database: string) {
    let folds: Promise<boolean> | undefined;
    const foldsCase = () => (folds ??= readFoldsCase(conn));
    return {
      foldsCase,
      reads: {
        info: () => readInfo(conn),
        sizeBytes: () => readSize(conn, database),
        listTables: () => readTables(conn, database),
        createOptions: () => readCreateOptions(conn, database),
        databaseKey: async () => ((await foldsCase()) ? database.toLowerCase() : database),
      },
    };
  }

  return {
    async openSource(endpoint: SourceEndpoint): Promise<SourceDatabase> {
      requireEndpoint(endpoint);
      const conn = await connect(endpoint, endpoint.ssl);
      const source: MysqlSource = {
        kind: 'source',
        ...readerFor(conn, endpoint.database).reads,
        // Read-only queries only: nothing on a source ever writes.
        async nonInnoDbTables() {
          const rows = await q<Row[]>(
            conn,
            `SELECT table_name AS name, engine AS engine FROM information_schema.tables
              WHERE table_schema = ? AND table_type = 'BASE TABLE' AND engine <> 'InnoDB' ORDER BY engine, table_name`,
            [endpoint.database],
          );
          return rows.map((r) => ({ name: String(r.name), engine: String(r.engine) }));
        },
        dump: (destPath, ctx) => runDump(conn, endpoint, endpoint.ssl, destPath, 'Downloading from dev', ctx),
        close: () => endQuietly(conn),
      };
      return source;
    },

    async openTarget(endpoint: Endpoint): Promise<TargetDatabase> {
      requireEndpoint(endpoint);
      const conn = await connect(endpoint, false);
      const name = endpoint.database;
      const { reads, foldsCase } = readerFor(conn, name);

      const exists = async (signal?: AbortSignal): Promise<boolean> =>
        (await q<Row[]>(conn, 'SELECT 1 AS present FROM information_schema.schemata WHERE schema_name = ?', [name], { signal })).length > 0;

      /** Database names compare without regard to case when the server says so; a processlist `db` is plain text. */
      const clientsWhere = async (alias: string) =>
        ((await foldsCase()) ? `LOWER(${alias}db) = LOWER(?)` : `${alias}db = ?`) + ` AND ${alias}id <> CONNECTION_ID()`;

      const defaultKillClients = async (signal: AbortSignal): Promise<void> => {
        const where = await clientsWhere('');
        const rows = await q<Row[]>(conn, `SELECT id FROM information_schema.processlist WHERE ${where}`, [name], { signal });
        for (const row of rows) {
          try {
            await q(conn, `KILL ${Number(row.id)}`, [], { signal });
          } catch (err) {
            if (signal.aborted) throw err;
            /* already gone, or one we may not end; the drop below reports what is left */
          }
        }
      };

      const otherClients = async (): Promise<string[]> => {
        try {
          const where = await clientsWhere('p.');
          // The program name needs performance_schema; the user name is always there.
          const sql = (select: string, from: string) => `SELECT DISTINCT ${select} AS app FROM ${from} WHERE ${where} ORDER BY 1`;
          let rows: Row[];
          try {
            rows = await q<Row[]>(
              conn,
              sql(
                'COALESCE(a.attr_value, p.user)',
                `information_schema.processlist p LEFT JOIN performance_schema.session_connect_attrs a
                   ON a.processlist_id = p.id AND a.attr_name = 'program_name'`,
              ),
              [name],
            );
          } catch {
            rows = await q<Row[]>(conn, sql('p.user', 'information_schema.processlist p'), [name]);
          }
          const names = rows.map((r) => String(r.app || '(unnamed program)'));
          return names.length > 0 ? names : ['(unknown program)'];
        } catch {
          return ['(unknown program)'];
        }
      };

      const target: TargetDatabase = {
        kind: 'target',
        ...reads,
        exists: () => exists(),
        async sizeBytes() {
          if (!(await exists())) return 0;
          return reads.sizeBytes();
        },
        async listTables() {
          if (!(await exists())) return [];
          return reads.listTables();
        },
        async canCreateDatabase() {
          const probe = `__dbsync_probe_${randomBytes(6).toString('hex')}`;
          try {
            await q(conn, `CREATE DATABASE ${mysql.escapeId(probe)}`, [], { timeoutMs: DDL_TIMEOUT_MS });
          } catch (err) {
            const errno = errnoOf(err);
            if (errno === ER_DBACCESS_DENIED || errno === ER_SPECIFIC_ACCESS_DENIED || errno === ER_TABLEACCESS_DENIED) return false;
            throw err;
          }
          try {
            await q(conn, `DROP DATABASE IF EXISTS ${mysql.escapeId(probe)}`, [], { timeoutMs: DDL_TIMEOUT_MS });
          } catch { /* the probe is empty and ours; a leftover is harmless */ }
          return true;
        },
        async dropDatabase(ctx) {
          const { signal } = ctx;
          if (!(await exists(signal))) return;
          await (deps.killClients ? deps.killClients(name) : defaultKillClients(signal));
          await q(conn, `SET SESSION lock_wait_timeout = ${LOCK_WAIT_SECONDS}`, [], { signal });
          try {
            // The only database this ever drops is the profile's own target.
            await q(conn, `DROP DATABASE IF EXISTS ${mysql.escapeId(name)}`, [], { signal, timeoutMs: DDL_TIMEOUT_MS });
          } catch (err) {
            // A lock that never freed, or a refusal for lack of privilege: the drop did not happen.
            const errno = errnoOf(err);
            if (errno !== undefined && DROP_REFUSED.has(errno)) throw new DropBlockedError(await otherClients());
            throw err;
          }
        },
        async createDatabase(options) {
          let sql = `CREATE DATABASE ${mysql.escapeId(name)}`;
          if (options.charset) sql += ` CHARACTER SET ${identifier(options.charset, 'character set')}`;
          if (options.collation) sql += ` COLLATE ${identifier(options.collation, 'collation')}`;
          await q(conn, sql, [], { timeoutMs: DDL_TIMEOUT_MS });
        },
        dump: (destPath, ctx) => runDump(conn, endpoint, undefined, destPath, 'Backing up local data', ctx),
        restore: (dumpPath, ctx) => runRestore(conn, endpoint, dumpPath, ctx),
        close: () => endQuietly(conn),
      };
      return target;
    },

    async engineChecks(source): Promise<CheckIssue[]> {
      if (!('nonInnoDbTables' in source)) {
        throw new Error('The MySQL adapter was given a database that is not from this adapter.');
      }
      const tables = await (source as MysqlSource).nonInnoDbTables();
      if (tables.length === 0) return [];
      const byEngine = new Map<string, string[]>();
      for (const t of tables) byEngine.set(t.engine, [...(byEngine.get(t.engine) ?? []), t.name]);
      const listing = [...byEngine].map(([engine, names]) => `${engine}: ${names.join(', ')}`).join('; ');
      return [{
        severity: 'warning',
        code: 'non-transactional-tables',
        message: `Dev has tables that are not InnoDB (${listing}). They are copied without a transaction, so the copy may mix data from different moments.`,
      }];
    },
  };
}
