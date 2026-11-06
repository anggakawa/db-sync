import { promises as fs } from 'node:fs';
import { Client, type ClientConfig } from 'pg';
import type { CheckIssue, Endpoint, SourceEndpoint } from '../../../shared/types';
import { runTool } from '../../process/process-runner';
import type { ToolLocator } from '../../tools/tool-locator';
import {
  DropBlockedError, type CreateOptions, type EngineAdapter, type ServerInfo, type SourceDatabase, type StepContext,
  type TargetDatabase,
} from '../adapter';
import { dumpArgs, missingExtensions, restoreArgs, toolEnv } from './args';

const OBJECT_IN_USE = '55006';
const DUMP_LINE = /dumping contents of table/;
const RESTORE_LINE = /processing data for table/;

/** Beyond the adapter interface: what engineChecks needs from each side. */
interface PostgresSource extends SourceDatabase { extensionNames(): Promise<string[]> }
interface PostgresTarget extends TargetDatabase { availableExtensions(): Promise<string[]> }

/** `pg` reads PG* variables (PGOPTIONS, PGPASSWORD...) when a client is constructed, so build it without them. */
function newClientWithoutPgEnv(config: ClientConfig): Client {
  const saved = Object.entries(process.env).filter(([key]) => /^PG/i.test(key));
  for (const [key] of saved) delete process.env[key];
  try {
    return new Client(config);
  } finally {
    for (const [key, value] of saved) process.env[key] = value;
  }
}

async function connect(ep: Endpoint, database: string, ssl: boolean): Promise<Client> {
  const client = newClientWithoutPgEnv({
    host: ep.host, port: ep.port, user: ep.user, database,
    // A function, so an empty password is never looked up in a password file.
    password: () => ep.password,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    application_name: 'DB Sync',
    client_encoding: 'UTF8',
    connectionTimeoutMillis: 20_000,
  });
  // A dropped connection must not crash the app; the next query reports it.
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

async function endQuietly(client: Client | undefined): Promise<void> {
  try { await client?.end(); } catch { /* already gone */ }
}

async function readInfo(client: Client): Promise<ServerInfo> {
  const { rows } = await client.query<{ num: string }>(`SELECT current_setting('server_version_num') AS num`);
  const major = Math.floor(Number(rows[0].num) / 10000);
  let identity: string | null = null;
  try {
    const res = await client.query<{ id: string }>('SELECT system_identifier::text AS id FROM pg_control_system()');
    identity = res.rows[0]?.id ?? null;
  } catch { /* no permission */ }
  return { flavor: 'postgres', version: [major, 0], versionLabel: String(major), identity };
}

async function readTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT schemaname || '.' || tablename AS name FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  );
  // Sorted here, not by the server, so two servers with different collations agree.
  return rows.map((r) => r.name).sort();
}

/** The encoding of the connected database, or of the named one. */
async function readCreateOptions(client: Client, database?: string): Promise<CreateOptions> {
  const { rows } = await client.query<{ encoding: string }>(
    `SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database
      WHERE datname = ${database === undefined ? 'current_database()' : '$1'}`,
    database === undefined ? [] : [database],
  );
  return rows[0] ? { encoding: rows[0].encoding } : {};
}

/** Counts matching tool lines and reports them as a percentage of `total` tables. */
function progressLines(pattern: RegExp, total: number, label: string, ctx: StepContext): (line: string) => void {
  let seen = 0;
  return (line) => {
    ctx.onLog(line);
    if (!pattern.test(line)) return;
    seen += 1;
    ctx.onProgress(label, total > 0 ? Math.min(100, Math.round((seen / total) * 100)) : null);
  };
}

export function createPostgresAdapter(deps: { locate: ToolLocator; tmpRoot: string }): EngineAdapter {
  async function runDump(ep: Endpoint, ssl: boolean | undefined, dest: string, total: number, label: string, ctx: StepContext) {
    await runTool({
      command: deps.locate.path('postgres', 'dump'),
      args: dumpArgs(ep, dest),
      env: toolEnv(ep, ssl),
      signal: ctx.signal,
      secrets: [ep.password],
      onLine: progressLines(DUMP_LINE, total, label, ctx),
    });
  }

  return {
    async openSource(endpoint: SourceEndpoint): Promise<SourceDatabase> {
      const client = await connect(endpoint, endpoint.database, endpoint.ssl);
      const source: PostgresSource = {
        kind: 'source',
        info: () => readInfo(client),
        // Read-only queries only: nothing on a source ever writes.
        async sizeBytes() {
          const { rows } = await client.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size');
          return Number(rows[0].size);
        },
        listTables: () => readTables(client),
        createOptions: () => readCreateOptions(client),
        async extensionNames() {
          const { rows } = await client.query<{ extname: string }>('SELECT extname FROM pg_extension');
          return rows.map((r) => r.extname);
        },
        async dump(destPath, ctx) {
          const total = (await readTables(client)).length;
          await runDump(endpoint, endpoint.ssl, destPath, total, 'Downloading from dev', ctx);
        },
        close: () => endQuietly(client),
      };
      return source;
    },

    async openTarget(endpoint: Endpoint): Promise<TargetDatabase> {
      // The target database may not exist yet, so the connection goes to a maintenance database.
      const client = await connect(endpoint, endpoint.database === 'postgres' ? 'template1' : 'postgres', false);
      const name = endpoint.database;

      const exists = async (): Promise<boolean> => {
        const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        return (rowCount ?? 0) > 0;
      };
      /** Runs `fn` on a short connection to the target database itself. */
      const inTarget = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
        const direct = await connect(endpoint, name, false);
        try { return await fn(direct); } finally { await endQuietly(direct); }
      };
      const otherClients = async (): Promise<string[]> => {
        const { rows } = await client.query<{ app: string }>(
          `SELECT DISTINCT application_name AS app FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY 1`,
          [name],
        );
        return rows.map((r) => r.app || '(unnamed program)');
      };

      const target: PostgresTarget = {
        kind: 'target',
        info: () => readInfo(client),
        exists,
        async sizeBytes() {
          if (!(await exists())) return 0;
          return inTarget(async (c) => {
            const { rows } = await c.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size');
            return Number(rows[0].size);
          });
        },
        async listTables() {
          if (!(await exists())) return [];
          return inTarget(readTables);
        },
        async createOptions() {
          return readCreateOptions(client, name);
        },
        async availableExtensions() {
          const { rows } = await client.query<{ name: string }>('SELECT name FROM pg_available_extensions');
          return rows.map((r) => r.name);
        },
        async canCreateDatabase() {
          const { rows } = await client.query<{ ok: boolean }>(
            'SELECT rolcreatedb OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user',
          );
          return rows[0]?.ok === true;
        },
        async dropDatabase(_ctx) {
          if (!(await exists())) return;
          try {
            await client.query(
              'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
              [name],
            );
          } catch { /* a session we may not end; the drop below reports it */ }
          const { rows } = await client.query<{ num: string }>(`SELECT current_setting('server_version_num') AS num`);
          const force = Number(rows[0].num) >= 130000 ? ' WITH (FORCE)' : '';
          try {
            // The only database this ever drops is the profile's own target.
            await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)}${force}`);
          } catch (err) {
            if ((err as { code?: string }).code === OBJECT_IN_USE) throw new DropBlockedError(await otherClients());
            throw err;
          }
        },
        async createDatabase(options) {
          const encoding = options.encoding ? ` ENCODING ${client.escapeLiteral(options.encoding)}` : '';
          await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)} TEMPLATE template0${encoding}`);
        },
        async dump(destPath, ctx) {
          const total = (await target.listTables()).length;
          await runDump(endpoint, undefined, destPath, total, 'Backing up local data', ctx);
        },
        async restore(dumpPath, ctx) {
          const entries = await fs.readdir(dumpPath).catch(() => [] as string[]);
          const total = entries.filter((f) => /^\d+\.dat/.test(f)).length;
          await runTool({
            command: deps.locate.path('postgres', 'restore'),
            args: restoreArgs(endpoint, dumpPath),
            env: toolEnv(endpoint),
            signal: ctx.signal,
            secrets: [endpoint.password],
            onLine: progressLines(RESTORE_LINE, total, 'Restoring local data', ctx),
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
      const used = await (source as PostgresSource).extensionNames();
      const available = await (target as PostgresTarget).availableExtensions();
      return missingExtensions(used, available).map((ext) => ({
        severity: 'blocker' as const,
        code: 'missing-extension',
        message: `Dev uses the "${ext}" extension, which is not installed on the local server. Install it, then try again.`,
      }));
    },
  };
}
