import type { CheckIssue, Endpoint, Flavor, SourceEndpoint } from '../../shared/types';

export interface ServerInfo {
  flavor: Flavor;
  version: [number, number]; // PostgreSQL minor is always 0
  versionLabel: string;
  identity: string | null;
}
export interface CreateOptions { encoding?: string; charset?: string; collation?: string }
export interface StepContext {
  signal: AbortSignal;
  onLog(line: string): void;
  onProgress(label: string, percent: number | null): void;
}

/** The drop was refused and nothing was deleted: other clients hold the database, or the account may not drop it. */
export class DropBlockedError extends Error {
  clients: string[];
  reason: 'clients' | 'permission';
  /** For a permission refusal, what the server said. */
  cause: string;
  constructor(clients: string[], reason: 'clients' | 'permission' = 'clients', cause = '') {
    super(reason === 'permission' ? `The account may not drop the database: ${cause}` : 'The database has other connected clients.');
    this.name = 'DropBlockedError';
    this.clients = clients;
    this.reason = reason;
    this.cause = cause;
  }
}

interface DatabaseReader {
  info(): Promise<ServerInfo>;
  sizeBytes(): Promise<number>; // 0 when the database does not exist
  listTables(): Promise<string[]>; // sorted "schema.table" or "table"; [] when the database does not exist
  createOptions(): Promise<CreateOptions>;
  /** The database name as the server compares it: folded to lower case when the server ignores case. */
  databaseKey(): Promise<string>;
  dump(destPath: string, ctx: StepContext): Promise<void>;
  close(): Promise<void>;
}

/** Read-only by construction: there is deliberately no write method. */
export interface SourceDatabase extends DatabaseReader { readonly kind: 'source' }

export interface TargetDatabase extends DatabaseReader {
  readonly kind: 'target';
  exists(): Promise<boolean>;
  canCreateDatabase(): Promise<boolean>;
  dropDatabase(ctx: StepContext): Promise<void>; // throws DropBlockedError with nothing deleted; no-op if absent
  createDatabase(options: CreateOptions): Promise<void>;
  restore(dumpPath: string, ctx: StepContext): Promise<void>;
}

export interface EngineAdapter {
  openSource(endpoint: SourceEndpoint): Promise<SourceDatabase>;
  openTarget(endpoint: Endpoint): Promise<TargetDatabase>;
  engineChecks(source: SourceDatabase, target: TargetDatabase): Promise<CheckIssue[]>;
}
