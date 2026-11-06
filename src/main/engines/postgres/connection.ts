import { Client, type ClientConfig, type QueryResultRow } from 'pg';
import type { Endpoint } from '../../../shared/types';
import { ToolCancelledError } from '../../process/process-runner';

export const METADATA_TIMEOUT_MS = 60_000;
export const DDL_TIMEOUT_MS = 5 * 60_000;
const END_TIMEOUT_MS = 5_000;

export class QueryTimeoutError extends Error {
  constructor(seconds: number) {
    super(`The database did not answer within ${seconds} seconds.`);
    this.name = 'QueryTimeoutError';
  }
}

/** A blank value would be replaced by a default (localhost, the OS user) inside the driver, so refuse it up front. */
export function requireEndpoint(ep: Endpoint): void {
  const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';
  if (blank(ep.host)) throw new Error('The host is required.');
  if (blank(ep.user)) throw new Error('The user is required.');
  if (blank(ep.database)) throw new Error('The database name is required.');
}

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

export async function connect(ep: Endpoint, database: string, ssl: boolean): Promise<Client> {
  requireEndpoint(ep);
  const client = newClientWithoutPgEnv({
    host: ep.host, port: ep.port, user: ep.user, database,
    // A function, so an empty password is never looked up in a password file.
    password: () => ep.password,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    application_name: 'DB Sync',
    client_encoding: 'UTF8',
    connectionTimeoutMillis: 20_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  // A dropped connection must not crash the app; the next query reports it.
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/** Closes the socket at once. A client that has timed out or been cancelled must never be reused. */
function destroy(client: Client): void {
  (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
}

export async function endQuietly(client: Client | undefined): Promise<void> {
  if (!client) return;
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<void>((resolve) => { timer = setTimeout(() => { destroy(client); resolve(); }, END_TIMEOUT_MS); });
  try { await Promise.race([client.end().catch(() => undefined), gaveUp]); } finally { clearTimeout(timer); }
}

/**
 * Runs one query with a deadline and an optional cancel signal. When either fires the connection is destroyed,
 * because pg's own timeout leaves the query running and queues later queries behind it.
 */
export function guardedQuery<R extends QueryResultRow = QueryResultRow>(
  client: Client, text: string, params: unknown[] = [], options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ rows: R[]; rowCount: number | null }> {
  const timeoutMs = options.timeoutMs ?? METADATA_TIMEOUT_MS;
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolCancelledError());
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => { destroy(client); reject(new ToolCancelledError()); });
    const timer = setTimeout(
      () => finish(() => { destroy(client); reject(new QueryTimeoutError(Math.round(timeoutMs / 1000))); }), timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    client.query<R>(text, params).then(
      (res) => finish(() => resolve(res)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}
