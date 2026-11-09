import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncPaths, type SyncPaths } from '../../src/main/sync/paths';
import { createLogStore } from '../../src/main/sync/sync-log';

const TIME = /^\d{2}:\d{2}:\d{2}\.\d{3} /;
let root: string;
let paths: SyncPaths;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sync-log-')); paths = createSyncPaths(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('sync log', () => {
  it('keeps the last 20 logs per profile', async () => {
    const logs = createLogStore(paths);
    for (let i = 0; i < 25; i += 1) {
      const log = await logs.open('p1', 'sync', []);
      log.write(`run ${i}`);
      await log.close();
    }
    const other = await logs.open('p2', 'sync', []);
    await other.close();
    const files = (await readdir(paths.logsDir('p1'))).sort();
    expect(files).toHaveLength(20);
    const texts = await Promise.all(files.map((f) => readFile(join(paths.logsDir('p1'), f), 'utf8')));
    expect(texts.some((t) => t.includes('run 0'))).toBe(false);
    expect(texts.some((t) => t.includes('run 4'))).toBe(false);
    expect(texts.some((t) => t.includes('run 5'))).toBe(true);
    expect(texts.some((t) => t.includes('run 24'))).toBe(true);
    expect(await readdir(paths.logsDir('p2'))).toHaveLength(1);
  });

  it('removes secrets from what it writes', async () => {
    const logs = createLogStore(paths);
    const log = await logs.open('p1', 'sync', ['hunter2', 'sourceSecret']);
    log.write('connecting with hunter2');
    log.write('password=sourceSecret;');
    await log.close();
    const [file] = await readdir(paths.logsDir('p1'));
    const text = await readFile(join(paths.logsDir('p1'), file), 'utf8');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('sourceSecret');
    expect(text).toContain('connecting with ***');
  });

  it('writes lines in order, one per line, and names the kind of run', async () => {
    const logs = createLogStore(paths);
    const log = await logs.open('p1', 'recover', []);
    log.write('first');
    log.write('second\nthird');
    await log.close();
    const [file] = await readdir(paths.logsDir('p1'));
    expect(file).toMatch(/recover\.log$/);
    const lines = (await readFile(join(paths.logsDir('p1'), file), 'utf8')).trim().split('\n');
    expect(lines.slice(1).map((l) => l.replace(TIME, ''))).toEqual(['first', 'second', 'third']);
  });

  it('never throws from write or close when the disk is unavailable', async () => {
    const logs = createLogStore(paths);
    const log = await logs.open('p1', 'sync', []);
    await rm(paths.logsDir('p1'), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    expect(() => log.write('x')).not.toThrow();
    await expect(log.close()).resolves.toBeUndefined();
  });

  it('starts every line with a local 24-hour time and the file with the date and app version', async () => {
    const at = new Date(2026, 10, 9, 14, 5, 7, 42); // local time: 9 Nov 2026 14:05:07.042
    const logs = createLogStore(paths, () => at.getTime(), '1.2.3');
    const log = await logs.open('p1', 'sync', []);
    log.write('hello');
    log.write('two\nlines');
    await log.close();
    const [file] = await readdir(paths.logsDir('p1'));
    const lines = (await readFile(join(paths.logsDir('p1'), file), 'utf8')).trimEnd().split('\n');
    expect(lines[0]).toBe('14:05:07.042 DB Sync 1.2.3, log started 2026-11-09 14:05:07.042 (local time)');
    expect(lines.slice(1)).toEqual(['14:05:07.042 hello', '14:05:07.042 two', '14:05:07.042 lines']);
  });

  it('keeps redacting behind the timestamp, in the header too', async () => {
    const logs = createLogStore(paths, Date.now, 'hunter2');
    const log = await logs.open('p1', 'sync', ['hunter2']);
    log.write('using hunter2');
    await log.close();
    const [file] = await readdir(paths.logsDir('p1'));
    const text = await readFile(join(paths.logsDir('p1'), file), 'utf8');
    expect(text).not.toContain('hunter2');
    expect(text).toContain(' using ***');
  });

  it('has lines on disk within a second without closing', async () => {
    const logs = createLogStore(paths);
    const log = await logs.open('p1', 'sync', []);
    const [file] = await readdir(paths.logsDir('p1'));
    const path = join(paths.logsDir('p1'), file);
    for (let i = 0; i < 5000; i += 1) log.write(`line ${i}`);
    await vi.waitFor(async () => {
      expect((await readFile(path, 'utf8')).trimEnd().split('\n').at(-1)).toMatch(/ line 4999$/);
    }, { timeout: 1000, interval: 50 });
    await log.close();
  });

  it('writes everything queued when closed straight away', async () => {
    const logs = createLogStore(paths);
    const log = await logs.open('p1', 'sync', []);
    for (let i = 0; i < 100; i += 1) log.write(`line ${i}`);
    await log.close();
    const [file] = await readdir(paths.logsDir('p1'));
    expect((await readFile(join(paths.logsDir('p1'), file), 'utf8')).trimEnd().split('\n')).toHaveLength(101);
  });
});
