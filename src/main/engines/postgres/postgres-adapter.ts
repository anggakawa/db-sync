import { promises as fs } from 'node:fs';
import type { Client } from 'pg';
import type { CheckIssue, Endpoint, SourceEndpoint } from '../../../shared/types';
import { runTool } from '../../process/process-runner';
import { usesOlderPostgresTools, type ToolLocator } from '../../tools/tool-locator';
import {
  DropBlockedError, type CreateOptions, type EngineAdapter, type ServerInfo, type SourceDatabase, type StepContext,
  type TargetDatabase,
} from '../adapter';
import { dumpArgs, missingExtensions, restoreArgs, toolEnv } from './args';
import { sizeOf } from '../../sync/stall-watch';
import { trackDump, trackRestore } from './progress';
import { connect, DDL_TIMEOUT_MS, endQuietly, guardedQuery as q, requireEndpoint } from './connection';

const OBJECT_IN_USE = '55006';
const INSUFFICIENT_PRIVILEGE = '42501';

/** Beyond the adapter interface: what engineChecks needs from each side. */
interface PostgresSource extends SourceDatabase { extensionNames(): Promise<string[]> }
interface PostgresTarget extends TargetDatabase { availableExtensions(): Promise<string[]> }

async function readInfo(client: Client): Promise<ServerInfo> {
  const { rows } = await q<{ num: string }>(client, `SELECT current_setting('server_version_num') AS num`);
  const major = Math.floor(Number(rows[0].num) / 10000);
  let identity: string | null = null;
  try {
    const res = await q<{ id: string }>(client, 'SELECT system_identifier::text AS id FROM pg_control_system()');
    identity = res.rows[0]?.id ?? null;
  } catch { /* no permission */ }
  return { flavor: 'postgres', version: [major, 0], versionLabel: String(major), identity };
}

async function readTables(client: Client): Promise<string[]> {
  // Other sessions' temporary tables are not part of the database's contents.
  const { rows } = await q<{ name: string }>(
    client,
    `SELECT schemaname || '.' || tablename AS name FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND schemaname !~ '^pg_(toast_)?temp_'`,
  );
  // Sorted here, not by the server, so two servers with different collations agree.
  return rows.map((r) => r.name).sort();
}

/** Tables that carry rows in a dump: partitioned parents (relkind 'p') hold none and have no TABLE DATA item. */
async function countDataTables(client: Client): Promise<number> {
  const { rows } = await q<{ n: string }>(
    client,
    `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast_)?temp_'`,
  );
  return Number(rows[0].n);
}

async function readSize(client: Client): Promise<number> {
  const { rows } = await q<{ size: string }>(client, 'SELECT pg_database_size(current_database())::text AS size');
  return Number(rows[0].size);
}

/** The encoding of the connected database, or of the named one. */
async function readCreateOptions(client: Client, database?: string): Promise<CreateOptions> {
  const { rows } = await q<{ encoding: string }>(
    client,
    `SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database
      WHERE datname = ${database === undefined ? 'current_database()' : '$1'}`,
    database === undefined ? [] : [database],
  );
  return rows[0] ? { encoding: rows[0].encoding } : {};
}

export function createPostgresAdapter(deps: { locate: ToolLocator; tmpRoot: string }): EngineAdapter {
  async function runDump(
    ep: Endpoint, ssl: boolean | undefined, dest: string, total: number, prefix: string, where: string, ctx: StepContext, serverMajor: number,
  ) {
    // pg_dump -Fd needs a missing or empty folder; a crash can leave one behind.
    await fs.rm(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    // The size poll reads the same folder the stall watch does; it stops on every path out of the dump.
    const progress = trackDump({ prefix, where, total, dest, ctx, measure: sizeOf });
    try {
      await runTool({
        // The tool matching the server it dumps: a pg_dump older than its server refuses it, and a newer one writes SETs an older server rejects.
        command: deps.locate.path('postgres', 'dump', serverMajor),
        args: dumpArgs(ep, dest),
        env: toolEnv(ep, ssl),
        signal: ctx.signal,
        secrets: [ep.password],
        onLine: progress.onLine,
      });
      await progress.stop(true);
    } finally {
      await progress.stop();
    }
  }

  return {
    async openSource(endpoint: SourceEndpoint): Promise<SourceDatabase> {
      requireEndpoint(endpoint);
      const client = await connect(endpoint, endpoint.database, endpoint.ssl);
      const source: PostgresSource = {
        kind: 'source',
        info: () => readInfo(client),
        // Read-only queries only: nothing on a source ever writes.
        sizeBytes: () => readSize(client),
        listTables: () => readTables(client),
        createOptions: () => readCreateOptions(client),
        databaseKey: async () => endpoint.database,
        async extensionNames() {
          const { rows } = await q<{ extname: string }>(client, 'SELECT extname FROM pg_extension');
          return rows.map((r) => r.extname);
        },
        async dump(destPath, ctx) {
          const total = await countDataTables(client);
          await runDump(endpoint, endpoint.ssl, destPath, total, 'Downloading from dev', 'dev', ctx, (await readInfo(client)).version[0]);
        },
        close: () => endQuietly(client),
      };
      return source;
    },

    async openTarget(endpoint: Endpoint): Promise<TargetDatabase> {
      requireEndpoint(endpoint);
      // The target database may not exist yet, so the connection goes to a maintenance database.
      const client = await connect(endpoint, endpoint.database === 'postgres' ? 'template1' : 'postgres', false);
      const name = endpoint.database;

      const exists = async (): Promise<boolean> => {
        const { rowCount } = await q(client, 'SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        return (rowCount ?? 0) > 0;
      };
      /** Runs `fn` on a short connection to the target database itself. */
      const inTarget = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
        const direct = await connect(endpoint, name, false);
        try { return await fn(direct); } finally { await endQuietly(direct); }
      };
      const otherClients = async (): Promise<string[]> => {
        try {
          const { rows } = await q<{ app: string }>(
            client,
            `SELECT DISTINCT application_name AS app FROM pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY 1`,
            [name],
          );
          const names = rows.map((r) => r.app || '(unnamed program)');
          return names.length > 0 ? names : ['(unknown program)'];
        } catch {
          return ['(unknown program)'];
        }
      };

      const target: PostgresTarget = {
        kind: 'target',
        info: () => readInfo(client),
        exists,
        async sizeBytes() {
          if (!(await exists())) return 0;
          return inTarget(readSize);
        },
        async listTables() {
          if (!(await exists())) return [];
          return inTarget(readTables);
        },
        async createOptions() {
          return readCreateOptions(client, name);
        },
        databaseKey: async () => name,
        async availableExtensions() {
          const { rows } = await q<{ name: string }>(client, 'SELECT name FROM pg_available_extensions');
          return rows.map((r) => r.name);
        },
        async canCreateDatabase() {
          const { rows } = await q<{ ok: boolean }>(
            client, 'SELECT rolcreatedb OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user',
          );
          return rows[0]?.ok === true;
        },
        async dropDatabase(ctx) {
          const { signal } = ctx;
          const meta = { signal };
          if (!(await q(client, 'SELECT 1 FROM pg_database WHERE datname = $1', [name], meta)).rowCount) return;
          try {
            await q(
              client,
              'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
              [name], meta,
            );
          } catch (err) {
            if (signal.aborted) throw err;
            /* a session we may not end; the drop below reports it */
          }
          const { rows } = await q<{ num: string }>(client, `SELECT current_setting('server_version_num') AS num`, [], meta);
          const force = Number(rows[0].num) >= 130000 ? ' WITH (FORCE)' : '';
          try {
            // The only database this ever drops is the profile's own target.
            await q(client, `DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)}${force}`, [], { signal, timeoutMs: DDL_TIMEOUT_MS });
          } catch (err) {
            // 55006: a session is still connected. 42501: FORCE could not end another role's session, or the role does not
            // own the database. Either way the drop was refused and nothing was deleted.
            const code = (err as { code?: string }).code;
            if (code === OBJECT_IN_USE) throw new DropBlockedError(await otherClients());
            if (code === INSUFFICIENT_PRIVILEGE) throw new DropBlockedError([], 'permission', (err as Error).message);
            throw err;
          }
        },
        async createDatabase(options) {
          const encoding = options.encoding ? ` ENCODING ${client.escapeLiteral(options.encoding)}` : '';
          await q(
            client, `CREATE DATABASE ${client.escapeIdentifier(name)} TEMPLATE template0${encoding}`, [],
            { timeoutMs: DDL_TIMEOUT_MS },
          );
        },
        async dump(destPath, ctx) {
          const total = (await target.exists()) ? await inTarget(countDataTables) : 0;
          await runDump(endpoint, undefined, destPath, total, 'Backing up local data', 'the local database', ctx, (await readInfo(client)).version[0]);
        },
        async restore(dumpPath, ctx) {
          const entries = await fs.readdir(dumpPath).catch(() => [] as string[]);
          const total = entries.filter((f) => /^\d+\.dat/.test(f)).length;
          const progress = trackRestore(total, ctx);
          await runTool({
            command: deps.locate.path('postgres', 'restore', (await readInfo(client)).version[0]),
            args: restoreArgs(endpoint, dumpPath),
            env: toolEnv(endpoint),
            signal: ctx.signal,
            secrets: [endpoint.password],
            onLine: progress.onLine,
          });
        },
        close: () => endQuietly(client),
      };
      return target;
    },

    async engineChecks(source, target): Promise<CheckIssue[]> {
      if (!('extensionNames' in source) || !('availableExtensions' in target)) {
        throw new Error('The PostgreSQL adapter was given a database that is not from this adapter.');
      }
      const issues: CheckIssue[] = [];
      // The newest pg_dump writes an archive the older pg_restore can't read, and it would only fail after the drop.
      const s = await source.info();
      const t = await target.info();
      if (!usesOlderPostgresTools(s.version[0]) && usesOlderPostgresTools(t.version[0])) {
        issues.push({
          severity: 'blocker', code: 'target-too-old',
          message: `Local PostgreSQL ${t.versionLabel} can't load this dump from dev ${s.versionLabel}. Upgrade your local image.`,
        });
      }
      const used = await (source as PostgresSource).extensionNames();
      const available = await (target as PostgresTarget).availableExtensions();
      issues.push(...missingExtensions(used, available).map((ext) => ({
        severity: 'blocker' as const,
        code: 'missing-extension',
        message: `Dev uses the "${ext}" extension, which is not installed on the local server. Install it, then try again.`,
      })));
      return issues;
    },
  };
}
