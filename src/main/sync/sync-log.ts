import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../process/redact';
import type { SyncPaths } from './paths';

export type RunKind = 'sync' | 'restore' | 'recover';
export const LOGS_KEPT = 20;

export interface RunLog {
  /** Redacts, then queues the line for the file. Never throws. */
  write(line: string): void;
  /** Waits for queued lines. Never rejects. */
  close(): Promise<void>;
}
export interface LogStore {
  /** Starts a new log file for one run and prunes the profile's older logs down to the last 20. */
  open(profileId: string, kind: RunKind, secrets: string[]): Promise<RunLog>;
}

const NOOP: RunLog = { write: () => undefined, close: async () => undefined };

/** A log is a convenience: a disk problem must never stop or fail a sync. */
export function createLogStore(paths: SyncPaths, now: () => number = Date.now): LogStore {
  let counter = 0;
  return {
    async open(profileId, kind, secrets) {
      const dir = paths.logsDir(profileId);
      let file: string;
      try {
        await fs.mkdir(dir, { recursive: true });
        // Names sort oldest first: a timestamp, then a counter for runs inside the same millisecond.
        counter += 1;
        const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
        const name = `${stamp}-${String(counter % 1_000_000).padStart(6, '0')}-${kind}.log`;
        file = join(dir, name);
        await fs.writeFile(file, '', { flag: 'wx' });
        const old = (await fs.readdir(dir)).filter((f) => f.endsWith('.log') && f !== name).sort();
        for (const f of old.slice(0, Math.max(0, old.length - (LOGS_KEPT - 1)))) {
          await fs.rm(join(dir, f), { force: true }).catch(() => undefined);
        }
      } catch {
        return NOOP;
      }
      let queue: Promise<unknown> = Promise.resolve();
      return {
        write(line) {
          const text = `${redact(line, secrets)}\n`;
          queue = queue.then(() => fs.appendFile(file, text, 'utf8')).catch(() => undefined);
        },
        async close() { await queue; },
      };
    },
  };
}
