import mysql, { type Connection } from 'mysql2/promise';
import type { Endpoint } from '../../../shared/types';
import { ToolCancelledError } from '../../process/process-runner';
import { END_TIMEOUT_MS, METADATA_TIMEOUT_MS, QueryTimeoutError, requireEndpoint } from '../limits';

/** MySQL error numbers the adapter reacts to. */
export const ER_DBACCESS_DENIED = 1044;
export const ER_TABLEACCESS_DENIED = 1142;
export const ER_SPECIFIC_ACCESS_DENIED = 1227;
export const ER_LOCK_WAIT_TIMEOUT = 1205;

export const errnoOf = (err: unknown): number | undefined => (err as { errno?: number } | null)?.errno;

/**
 * Connects without a default database, because the target database may not exist yet.
 * mysql2 does not read MYSQL_* variables, so nothing inherited can change where this connects.
 */
export async function connect(ep: Endpoint, ssl: boolean): Promise<Connection> {
  requireEndpoint(ep);
  const conn = await mysql.createConnection({
    host: ep.host, port: ep.port, user: ep.user, password: ep.password,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    charset: 'UTF8MB4_UNICODE_CI',
    connectTimeout: 20_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });
  // A dropped connection must not crash the app; the next query reports it.
  conn.on('error', () => undefined);
  try {
    // MySQL caches table statistics for a day, which would make sizes read as zero right after a restore.
    await conn.query('SET SESSION information_schema_stats_expiry = 0');
  } catch { /* MariaDB has no such variable, and nothing else depends on it */ }
  return conn;
}

/** Closes the socket at once. A connection that has timed out or been cancelled must never be reused. */
function destroy(conn: Connection): void {
  try { conn.destroy(); } catch { /* already gone */ }
}

export async function endQuietly(conn: Connection | undefined): Promise<void> {
  if (!conn) return;
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<void>((resolve) => { timer = setTimeout(() => { destroy(conn); resolve(); }, END_TIMEOUT_MS); });
  try { await Promise.race([conn.end().catch(() => undefined), gaveUp]); } finally { clearTimeout(timer); }
}

/** Runs one statement with a deadline and an optional cancel signal. When either fires the connection is destroyed. */
export function guardedQuery<R = Array<Record<string, unknown>>>(
  conn: Connection, sql: string, params: unknown[] = [], options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<R> {
  const timeoutMs = options.timeoutMs ?? METADATA_TIMEOUT_MS;
  const { signal } = options;
  return new Promise<R>((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolCancelledError());
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => { destroy(conn); reject(new ToolCancelledError()); });
    const timer = setTimeout(
      () => finish(() => { destroy(conn); reject(new QueryTimeoutError(Math.round(timeoutMs / 1000))); }), timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    conn.query(sql, params).then(
      ([rows]) => finish(() => resolve(rows as R)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}
