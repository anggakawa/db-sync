import { promises as fs } from 'node:fs';
import { createSyncPaths, type SyncPaths } from '../../../src/main/sync/paths';
import { createSyncRunner, type RunCallbacks } from '../../../src/main/sync/sync-runner';
import type { EngineAdapter } from '../../../src/main/engines/adapter';
import type { Profile, SyncEvent, SyncOutcome } from '../../../src/shared/types';

/** A real runner around `adapter`, with every local-host and disk check passing. */
export function createTestRunner(adapter: EngineAdapter, rootDir: string) {
  const paths: SyncPaths = createSyncPaths(rootDir);
  const runner = createSyncRunner({
    adapterFor: () => adapter,
    paths,
    checkTarget: async () => ({ allowed: true }),
    freeDiskBytes: async () => {
      await fs.mkdir(paths.tmpRoot, { recursive: true });
      const s = await fs.statfs(paths.tmpRoot);
      return Number(s.bavail) * Number(s.bsize);
    },
  });
  const run = async (call: (cb: RunCallbacks) => Promise<SyncOutcome>) => {
    const events: SyncEvent[] = [];
    const outcome = await call({
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      confirmWarnings: async () => true,
    });
    return { outcome, events };
  };
  return { runner, paths, run };
}

export function runSyncForTest(
  adapter: EngineAdapter, profile: Profile, rootDir: string,
): Promise<{ outcome: SyncOutcome; events: SyncEvent[] }> {
  const { runner, run } = createTestRunner(adapter, rootDir);
  return run((cb) => runner.sync(profile, cb));
}
