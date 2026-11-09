import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../process/redact';
import type { SyncPaths } from './paths';

export type RunKind = 'sync' | 'restore' | 'recover';
export const LOGS_KEPT = 20;

export interface RunLog {
  /** Redacts, timestamps and buffers the line; it reaches the file within about a second. Never throws. */
  write(line: string): void;
  /** Writes everything buffered and waits for it. Never rejects. */
  close(): Promise<void>;
}
export interface LogStore {
  /** Starts a new log file for one run and prunes the profile's older logs down to the last 20. */
  open(profileId: string, kind: RunKind, secrets: string[]): Promise<RunLog>;
}

/** The file never trails the events by more than about this long. */
const FLUSH_MS = 250;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** Local time, 24-hour: 14:05:07.042 */
const clockTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
/** Local date and time: 2026-11-09 14:05:07.042 */
const dateTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(ms)}`;
};

const NOOP: RunLog = { write: () => undefined, close: async () => undefined };

/** A log is a convenience: a disk problem must never stop or fail a sync. */
export function createLogStore(paths: SyncPaths, now: () => number = Date.now, version = 'unknown'): LogStore {
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
      let pending = '';
      let timer: NodeJS.Timeout | undefined;
      let closed = false;
      /** Hands everything buffered to the file, in order. */
      const flush = () => {
        if (timer) { clearTimeout(timer); timer = undefined; }
        if (pending === '') return;
        const text = pending;
        pending = '';
        queue = queue.then(() => fs.appendFile(file, text, 'utf8')).catch(() => undefined);
      };
      const add = (line: string) => {
        const at = now();
        const stamp = clockTime(at);
        for (const part of redact(line, secrets).split('\n')) pending += `${stamp} ${part}\n`;
        // One append per short interval, not one per line: a big restore prints thousands of lines.
        if (closed) flush();
        else if (!timer) { timer = setTimeout(flush, FLUSH_MS); timer.unref(); }
      };
      add(`DB Sync ${version}, log started ${dateTime(now())} (local time)`);
      flush();
      return {
        write: add,
        async close() { closed = true; flush(); await queue; },
      };
    },
  };
}
