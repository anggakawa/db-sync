import type { StepContext } from '../adapter';
import { dumpTablesLabel, readingLabel, restoreTablesLabel } from '../progress-format';

/**
 * pg_dump and pg_restore (--verbose) both print `finished item N TABLE DATA name` when a table's rows are done.
 * Anchored at the line start (after an optional tool prefix), so a table name containing the phrase cannot count.
 * The prefix may be missing: with parallel workers two lines can interleave and leave only a leading space.
 */
const FINISHED_TABLE = /^(?:pg_\w+:\s*)*\s*finished item \d+ TABLE DATA /;
/** pg_dump prints this when it starts copying a table, which means it is done reading the database structure. */
const DUMP_STARTED_TABLE = /dumping contents of table/;

export const isFinishedTable = (line: string): boolean => FINISHED_TABLE.test(line);
export const isDumpStart = (line: string): boolean => DUMP_STARTED_TABLE.test(line);

export function countFinishedTables(lines: string[]): number {
  return lines.filter(isFinishedTable).length;
}

export interface TableProgress {
  /** The tool's output lines, in order. Also forwards each one to the run's log. */
  onLine(line: string): void;
  /** Stops polling and, when `final`, reports the end state once more. Safe to call on every path, repeatedly. */
  stop(final?: boolean): Promise<void>;
}

/** Never more than `total` when there is one. */
const capped = (n: number, total: number): number => (total > 0 ? Math.min(n, total) : n);
const percentOf = (done: number, total: number): number | null => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null);

/** A dump: finished tables and the folder's size, refreshed every `pollMs` so a long table does not look frozen. */
export function trackDump(opts: {
  prefix: string; where: string; total: number; dest: string; ctx: StepContext;
  measure: (path: string) => Promise<number>; pollMs?: number;
}): TableProgress {
  const { prefix, where, total, dest, ctx, measure } = opts;
  let done = 0;
  let bytes = 0;
  let reading = true;
  let stopped = false;
  let polling = false;
  const emit = () => {
    if (reading) ctx.onProgress(readingLabel(where), null);
    else ctx.onProgress(dumpTablesLabel(prefix, done, total, bytes), percentOf(done, total));
  };
  const refresh = async () => {
    try { bytes = await measure(dest); } catch { /* keep the last size */ }
  };
  emit();
  const timer = setInterval(async () => {
    if (stopped || polling || reading) return;
    polling = true;
    try { await refresh(); } finally { polling = false; }
    if (!stopped) emit();
  }, opts.pollMs ?? 2_000);
  return {
    onLine(line) {
      ctx.onLog(line);
      if (stopped) return;
      if (reading && isDumpStart(line)) { reading = false; emit(); }
      if (isFinishedTable(line)) { reading = false; done = capped(done + 1, total); emit(); }
    },
    async stop(final = false) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // The tool succeeded, so every table is done, even those with no TABLE DATA item (extension-owned, empty partitions).
      if (final) { await refresh(); reading = false; if (total > 0) done = total; emit(); }
    },
  };
}

/** A restore: finished tables only; the tool's input is already on disk. */
export function trackRestore(total: number, ctx: StepContext): TableProgress {
  let done = 0;
  const emit = () => ctx.onProgress(restoreTablesLabel(done, total), percentOf(done, total));
  emit();
  return {
    onLine(line) {
      ctx.onLog(line);
      if (isFinishedTable(line)) { done = capped(done + 1, total); emit(); }
    },
    async stop() { /* nothing to stop */ },
  };
}
