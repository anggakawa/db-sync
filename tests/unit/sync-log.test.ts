import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncPaths, type SyncPaths } from '../../src/main/sync/paths';
import { createLogStore } from '../../src/main/sync/sync-log';

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
    expect((await readFile(join(paths.logsDir('p1'), file), 'utf8')).trim().split('\n')).toEqual(['first', 'second', 'third']);
  });

  it('never throws from write or close when the disk is unavailable', async () => {
    const logs = createLogStore(paths);
    const log = await logs.open('p1', 'sync', []);
    await rm(paths.logsDir('p1'), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    expect(() => log.write('x')).not.toThrow();
    await expect(log.close()).resolves.toBeUndefined();
  });
});
