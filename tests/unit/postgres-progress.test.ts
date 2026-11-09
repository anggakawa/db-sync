import { describe, expect, it, vi } from 'vitest';
import { countFinishedTables, trackDump, trackRestore } from '../../src/main/engines/postgres/progress';

// Lines as the bundled pg_dump / pg_restore print them with --verbose and --jobs=4 (captured from a real run).
const DUMP = [
  'pg_dump: reading user-defined tables',
  'pg_dump: dumping contents of table "public.customers"',
  'pg_dump: executing SELECT pg_catalog.set_config(\'search_path\', \'\', false);',
  'pg_dump: finished item 5108 TABLE DATA customers',
  'pg_dump: dumping contents of table "extra.items"',
  'pg_dump: finished item 5114 TABLE DATA items',
  'pg_dump: dumping contents of table "public.t0"',
  'pg_dump: dumping contents of table "public.t1"',
  'pg_dump: dumping contents of table "public.t2"',
  'pg_dump: dumping contents of table "public.t3"',
  'pg_dump: finished item 5116 TABLE DATA t0',
];
const RESTORE = [
  'pg_restore: processing item 231 TABLE t0',
  'pg_restore: entering main parallel loop',
  'pg_restore: launching item 5121 TABLE DATA t5',
  'pg_restore: launching item 5120 TABLE DATA t4',
  'pg_restore: processing data for table "public.t5"',
  'pg_restore: finished item 5119 TABLE DATA t3',
  'pg_restore: launching item 5113 TABLE DATA blobs',
  'pg_restore: finished item 5113 TABLE DATA blobs',
  'pg_restore: launching item 4954 CONSTRAINT blobs blobs_pkey',
  'pg_restore: finished item 4954 CONSTRAINT blobs blobs_pkey',
  'pg_restore: finished item 5132 SEQUENCE SET audit_id_seq',
  // Two workers wrote at once: the prefix of the next line is lost.
  'pg_restore:pg_restore: executing SEQUENCE SET audit_id_seq',
  ' finished item 5116 TABLE DATA t0',
  'pg_restore: finished main parallel loop',
];

describe('countFinishedTables', () => {
  it('counts finished tables, not started ones', () => {
    // Seven "dumping contents" lines start more tables than the three that have finished.
    expect(countFinishedTables(DUMP)).toBe(3);
  });
  it('counts only TABLE DATA items in a restore', () => {
    // t3, blobs and the garbled t0 line; launches, constraints and sequence sets are not tables.
    expect(countFinishedTables(RESTORE)).toBe(3);
  });
  it('ignores lines that merely mention a table', () => {
    expect(countFinishedTables(['pg_dump: finished item 12 INDEX TABLE DATA_idx', 'pg_dump: dumping contents of table "a"'])).toBe(0);
  });
});

describe('trackDump', () => {
  const setup = (total: number, sizes: number[]) => {
    const progress: Array<[string, number | null]> = [];
    const logs: string[] = [];
    const ctx = { signal: new AbortController().signal, onLog: (l: string) => logs.push(l), onProgress: (l: string, p: number | null) => progress.push([l, p]) };
    let i = 0;
    const measure = async () => sizes[Math.min(i++, sizes.length - 1)];
    const t = trackDump({ prefix: 'Downloading from dev', where: 'dev', total, dest: 'x', ctx, measure, pollMs: 2000 });
    return { t, progress, logs };
  };

  it('reads the table list first, then counts finished tables with the size', async () => {
    vi.useFakeTimers();
    try {
      const { t, progress, logs } = setup(4, [1024 * 1024]);
      expect(progress).toEqual([['Reading the table list from dev...', null]]);
      t.onLine('pg_dump: reading indexes');
      expect(progress).toHaveLength(1);
      t.onLine('pg_dump: dumping contents of table "public.a"');
      t.onLine('pg_dump: dumping contents of table "public.b"');
      expect(progress.at(-1)).toEqual(['Downloading from dev: 0 of 4 tables, 0 B so far', 0]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(progress.at(-1)).toEqual(['Downloading from dev: 0 of 4 tables, 1.0 MB so far', 0]);
      t.onLine('pg_dump: finished item 1 TABLE DATA a');
      expect(progress.at(-1)).toEqual(['Downloading from dev: 1 of 4 tables, 1.0 MB so far', 25]);
      expect(logs).toHaveLength(4);
      await t.stop();
    } finally { vi.useRealTimers(); }
  });

  it('keeps reporting size while one long table copies, and stops polling when stopped', async () => {
    vi.useFakeTimers();
    try {
      const { t, progress } = setup(2, [100, 200, 300, 400]);
      t.onLine('pg_dump: dumping contents of table "public.a"');
      await vi.advanceTimersByTimeAsync(4000);
      expect(progress.map(([l]) => l).slice(-2)).toEqual([
        'Downloading from dev: 0 of 2 tables, 100 B so far', 'Downloading from dev: 0 of 2 tables, 200 B so far',
      ]);
      await t.stop();
      const count = progress.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(progress).toHaveLength(count);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('reports the end state with a fresh size when stopped as finished', async () => {
    const { t, progress } = setup(1, [5 * 1024 * 1024]);
    t.onLine('pg_dump: dumping contents of table "public.a"');
    t.onLine('pg_dump: finished item 1 TABLE DATA a');
    await t.stop(true);
    expect(progress.at(-1)).toEqual(['Downloading from dev: 1 of 1 tables, 5.0 MB so far', 100]);
  });
});

describe('trackRestore', () => {
  it('counts finished tables and reaches 100', () => {
    const progress: Array<[string, number | null]> = [];
    const t = trackRestore(2, { signal: new AbortController().signal, onLog: () => undefined, onProgress: (l, p) => progress.push([l, p]) });
    t.onLine('pg_restore: launching item 5 TABLE DATA a');
    t.onLine('pg_restore: finished item 5 TABLE DATA a');
    t.onLine('pg_restore: finished item 6 TABLE DATA b');
    expect(progress).toEqual([['Restoring: 0 of 2 tables', 0], ['Restoring: 1 of 2 tables', 50], ['Restoring: 2 of 2 tables', 100]]);
  });
});
