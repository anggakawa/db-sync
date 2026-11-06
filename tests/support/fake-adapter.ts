import { promises as fs } from 'node:fs';
import type { CheckIssue, Endpoint, SourceEndpoint } from '../../src/shared/types';
import type {
  CreateOptions, EngineAdapter, ServerInfo, SourceDatabase, StepContext, TargetDatabase,
} from '../../src/main/engines/adapter';

export type FakeMethod =
  | 'source.dump' | 'target.dump' | 'target.dropDatabase' | 'target.createDatabase' | 'target.restore';

export interface FakeConfig {
  sourceInfo: ServerInfo;
  targetInfo: ServerInfo;
  sourceTables: string[];
  targetTables: string[];
  sourceSize: number;
  targetSize: number;
  targetExists: boolean;
  canCreate: boolean;
  sourceCreateOptions: CreateOptions;
  targetCreateOptions: CreateOptions;
  engineIssues: CheckIssue[];
  /** Methods that throw when called. */
  failures: Partial<Record<FakeMethod, Error>>;
  /** Methods that throw on their first call only. */
  failuresOnce: Partial<Record<FakeMethod, Error>>;
  /** Runs inside a method, after it is recorded and before it finishes. */
  hooks: Partial<Record<FakeMethod, () => void | Promise<void>>>;
}

export const pgInfo = (v: number, identity: string | null): ServerInfo =>
  ({ flavor: 'postgres', version: [v, 0], versionLabel: String(v), identity });

/** `calls` records only dumps and writes, in order. Opens and closes are tracked separately. */
export function createFakeAdapter(overrides: Partial<FakeConfig> = {}) {
  const config: FakeConfig = {
    sourceInfo: pgInfo(16, 'dev-server'),
    targetInfo: pgInfo(16, 'local-server'),
    sourceTables: ['public.a', 'public.b'],
    targetTables: ['public.a', 'public.b'],
    sourceSize: 100,
    targetSize: 100,
    targetExists: true,
    canCreate: true,
    sourceCreateOptions: { encoding: 'UTF8', collation: 'en_US' },
    targetCreateOptions: { encoding: 'LATIN1' },
    engineIssues: [],
    failures: {},
    failuresOnce: {},
    hooks: {},
    ...overrides,
  };
  const calls: string[] = [];
  const created: CreateOptions[] = [];
  const restoredPaths: string[] = [];
  const opens: string[] = [];
  const closes: string[] = [];

  const step = async (name: FakeMethod, destPath?: string) => {
    calls.push(name);
    await config.hooks[name]?.();
    const failure = config.failuresOnce[name] ?? config.failures[name];
    delete config.failuresOnce[name];
    if (failure) throw failure;
    if (destPath) await fs.writeFile(destPath, name);
  };

  const source: SourceDatabase = {
    kind: 'source',
    info: async () => config.sourceInfo,
    sizeBytes: async () => config.sourceSize,
    listTables: async () => config.sourceTables,
    createOptions: async () => config.sourceCreateOptions,
    dump: async (dest: string, _ctx: StepContext) => step('source.dump', dest),
    close: async () => { closes.push('source'); },
  };
  const target: TargetDatabase = {
    kind: 'target',
    info: async () => config.targetInfo,
    sizeBytes: async () => (config.targetExists ? config.targetSize : 0),
    listTables: async () => (config.targetExists ? config.targetTables : []),
    createOptions: async () => config.targetCreateOptions,
    dump: async (dest: string, _ctx: StepContext) => step('target.dump', dest),
    exists: async () => config.targetExists,
    canCreateDatabase: async () => config.canCreate,
    dropDatabase: async (_ctx: StepContext) => step('target.dropDatabase'),
    createDatabase: async (options: CreateOptions) => { created.push(options); await step('target.createDatabase'); },
    restore: async (path: string, _ctx: StepContext) => { restoredPaths.push(path); await step('target.restore'); },
    close: async () => { closes.push('target'); },
  };
  const adapter: EngineAdapter = {
    openSource: async (_e: SourceEndpoint) => { opens.push('source'); return source; },
    openTarget: async (_e: Endpoint) => { opens.push('target'); return target; },
    engineChecks: async () => config.engineIssues,
  };
  return { adapter, config, calls, created, restoredPaths, opens, closes };
}
