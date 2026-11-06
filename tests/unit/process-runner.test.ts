import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { ToolCancelledError, ToolError, runTool, type ToolRun } from '../../src/main/process/process-runner';

const fixture = resolve(__dirname, 'fixtures', 'fake-tool.mjs');
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dbsync-runner-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function base(args: string[], extra: Partial<ToolRun> = {}): ToolRun {
  return { command: process.execPath, args, signal: new AbortController().signal, secrets: [], ...extra };
}

async function capture(run: ToolRun): Promise<string> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  await runTool({ ...run, stdout: out });
  return Buffer.concat(chunks).toString('utf8');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runTool', () => {
  it('passes args with spaces and quotes unchanged, without a shell', async () => {
    const args = ['a b', 'c"d', '%PATH%'];
    const out = JSON.parse(await capture(base([fixture, 'echo', ...args])));
    expect(out.args).toEqual(args);
  });

  it('runs a tool whose own path contains spaces and non-ASCII characters', async () => {
    const dir = join(tmp, 'dá ta sync');
    mkdirSync(dir);
    const copy = join(dir, 'fake-tool.mjs');
    copyFileSync(fixture, copy);
    const out = JSON.parse(await capture(base([copy, 'echo', 'ok'])));
    expect(out.args).toEqual(['ok']);
  });

  it('runs the tool in the folder it is given, even one with non-ASCII characters', async () => {
    const dir = join(tmp, 'dá cwd');
    mkdirSync(dir);
    expect((await capture(base([fixture, 'cwd'], { cwd: dir }))).toLowerCase()).toBe(dir.toLowerCase());
  });

  it('rejects with ToolError and a redacted 64 KB stderr tail on non-zero exit', async () => {
    const err = await runTool(base([fixture, 'bigerr', 'hunter2', '3'], { secrets: ['hunter2'] })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    const e = err as ToolError;
    expect(e.exitCode).toBe(3);
    expect(e.stderrTail).toContain('password is ***');
    expect(e.stderrTail).not.toContain('hunter2');
    expect(e.stderrTail.length).toBeLessThanOrEqual(64 * 1024);
    expect(e.stderrTail.length).toBeGreaterThan(60 * 1024);
    expect(e.message).not.toContain('hunter2');
  });

  it('sends redacted stderr lines to onLine', async () => {
    const lines: string[] = [];
    await runTool(base([fixture, 'stderr', 'token=hunter2 done', '0'], { secrets: ['hunter2'], onLine: (l) => lines.push(l) }));
    expect(lines).toEqual(['token=*** done']);
  });

  it('sends redacted stdout lines to onLine when no stdout target is set', async () => {
    const lines: string[] = [];
    await runTool(base([fixture, 'echo', 'hunter2'], { secrets: ['hunter2'], onLine: (l) => lines.push(l) }));
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(lines.join('\n')).toContain('***');
  });

  it('applies cleanEnv even when run.env is given', async () => {
    const prev = process.env.PGPASSWORD;
    process.env.PGPASSWORD = 'inherited';
    try {
      const out = JSON.parse(await capture(base([fixture, 'echo'], { env: { MYSQL_PWD: 'given', KEEP: '1' } })));
      // inherited PG* is dropped; variables the caller passes explicitly are its choice
      expect(out.env.PGPASSWORD).toBeUndefined();
      expect(out.env.KEEP).toBe('1');
      expect(out.env.MYSQL_PWD).toBe('given');
    } finally {
      if (prev === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = prev;
    }
  });

  it('accepts a stdin stream', async () => {
    const stdin = new PassThrough();
    stdin.end('hello');
    // echo mode ignores stdin; this proves a supplied stdin neither hangs nor fails
    await runTool(base([fixture, 'echo'], { stdin, stdout: new PassThrough() }));
  });

  it('fails when the stdout target errors', async () => {
    const bad = new Writable({
      write(_c, _e, cb) {
        cb(new Error('disk full'));
      },
    });
    await expect(runTool(base([fixture, 'echo'], { stdout: bad }))).rejects.toThrow('disk full');
  });

  it('rejects when the command cannot be started', async () => {
    await expect(runTool(base([], { command: join(tmp, 'does-not-exist.exe') }))).rejects.toThrow();
  });

  it('rejects with ToolCancelledError and leaves no child alive when aborted', async () => {
    const pidFile = join(tmp, 'grandchild.pid');
    const ac = new AbortController();
    const settled = runTool(base([fixture, 'sleep', pidFile], { signal: ac.signal })).then(
      () => null,
      (e: unknown) => e,
    );
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        pid = Number(readFileSync(pidFile, 'utf8'));
      } catch {
        /* not written yet */
      }
    }
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    ac.abort();
    expect(await settled).toBeInstanceOf(ToolCancelledError);
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  }, 15000);

  it('rejects immediately when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runTool(base([fixture, 'echo'], { signal: ac.signal }))).rejects.toBeInstanceOf(ToolCancelledError);
  });
});
