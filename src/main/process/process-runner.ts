import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cleanEnv, redact } from './redact';

export { cleanEnv, redact };

const STDERR_TAIL_BYTES = 64 * 1024;

export class ToolError extends Error {
  constructor(
    public exitCode: number | null,
    public stderrTail: string,
  ) {
    super(`Tool exited with code ${exitCode}`);
    this.name = 'ToolError';
  }
}

export class ToolCancelledError extends Error {
  constructor() {
    super('Tool was cancelled');
    this.name = 'ToolCancelledError';
  }
}

export interface ToolRun {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Working folder of the tool; the process's own when unset. */
  cwd?: string;
  signal: AbortSignal;
  secrets: string[];
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Redacted stderr lines, and stdout lines when `stdout` is not set. */
  onLine?: (line: string) => void;
}

function killTree(pid: number | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (pid === undefined) return resolve();
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => resolve());
    killer.on('close', () => resolve());
  });
}

function keepTail(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= STDERR_TAIL_BYTES) return text;
  // Drop leading bytes, then any partial character left at the cut.
  return buf.subarray(buf.length - STDERR_TAIL_BYTES).toString('utf8').replace(/^�+/, '');
}

export function runTool(run: ToolRun): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (run.signal.aborted) return reject(new ToolCancelledError());

    const child = spawn(run.command, run.args, {
      shell: false,
      windowsHide: true,
      cwd: run.cwd,
      env: { ...cleanEnv(process.env), ...run.env },
      stdio: [run.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    let stderrText = '';
    let failure: Error | undefined;
    let cancelled = false;
    let exit: { code: number | null } | undefined;
    let pendingStreams = 0;
    let settled = false;

    const finish = (): void => {
      if (settled || exit === undefined || pendingStreams > 0) return;
      settled = true;
      run.signal.removeEventListener('abort', onAbort);
      if (cancelled) return reject(new ToolCancelledError());
      if (failure) return reject(failure);
      if (exit.code !== 0) return reject(new ToolError(exit.code, keepTail(stderrText)));
      resolve();
    };

    const fail = (err: Error): void => {
      if (!failure) failure = err;
      void killTree(child.pid);
    };

    const onAbort = (): void => {
      cancelled = true;
      void killTree(child.pid);
    };
    run.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      // Spawn failure: no process, so no 'close' will follow.
      if (settled) return;
      settled = true;
      run.signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    const emit = (line: string): void => run.onLine?.(redact(line, run.secrets));

    createInterface({ input: child.stderr! }).on('line', (line) => {
      const clean = redact(line, run.secrets);
      stderrText = keepTail(stderrText + clean + '\n');
      run.onLine?.(clean);
    });

    if (run.stdout) {
      const target = run.stdout;
      pendingStreams++;
      let targetDone = false;
      const done = (): void => {
        if (targetDone) return;
        targetDone = true;
        pendingStreams--;
        finish();
      };
      target.once('finish', done);
      target.once('error', (err: Error) => {
        fail(err);
        done();
      });
      child.stdout!.on('error', fail);
      child.stdout!.pipe(target);
    } else {
      createInterface({ input: child.stdout! }).on('line', emit);
    }

    if (run.stdin && child.stdin) {
      // A tool that exits early closes its stdin; that is not a failure by itself.
      child.stdin.on('error', () => undefined);
      run.stdin.on('error', fail);
      run.stdin.pipe(child.stdin);
    }

    child.on('close', (code) => {
      exit = { code };
      // If the child died before the stdout target finished (error/kill), do not wait forever.
      if (run.stdout && (failure || cancelled) && pendingStreams > 0) {
        pendingStreams = 0;
        (run.stdout as { destroy?: () => void }).destroy?.();
      }
      finish();
    });
  });
}
