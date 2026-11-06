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

export class DropBlockedError extends Error {
  clients: string[];
  constructor(clients: string[], message = 'The database has other connected clients.') {
    super(message);
    this.name = 'DropBlockedError';
    this.clients = clients;
  }
}

interface DatabaseReader {
  info(): Promise<ServerInfo>;
  sizeBytes(): Promise<number>; // 0 when the database does not exist
  listTables(): Promise<string[]>; // sorted "schema.table" or "table"; [] when the database does not exist
  createOptions(): Promise<CreateOptions>;
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
