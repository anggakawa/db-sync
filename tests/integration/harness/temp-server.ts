import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from '../../../src/main/process/redact';

export type ServerName = 'postgres' | 'postgres-old' | 'mysql' | 'mariadb';
export interface TempServer {
  host: '127.0.0.1';
  port: number;
  user: string;
  password: string;
  stop(): Promise<void>;
}

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BUNDLED_TOOLS = resolve(REPO_ROOT, 'resources', 'tools');

/** Asks the OS for a free port on loopback. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
  });
}

/** Runs a server binary to completion with a clean environment. stdio is ignored so a daemon cannot hold a pipe open. */
function run(exe: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(exe, args, { shell: false, windowsHide: true, stdio: 'ignore', env: cleanEnv(process.env) });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${exe} timed out`)); }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(); else reject(new Error(`${exe} ${args[0] ?? ''} exited with ${code}`));
    });
  });
}

async function startPostgres(name: 'postgres' | 'postgres-old', emptyPassword: boolean): Promise<TempServer> {
  const bin = join(REPO_ROOT, '.cache', 'servers', name, 'bin');
  const dir = await fs.mkdtemp(join(tmpdir(), `dbsync-${name}-`));
  const data = join(dir, 'data');
  const user = 'sync_test';
  const password = emptyPassword ? '' : randomBytes(12).toString('hex');
  const port = await freePort();
  const pwfile = join(dir, 'pw.txt');
  let started = false;

  const stop = async (): Promise<void> => {
    if (started) {
      started = false;
      await run(join(bin, 'pg_ctl.exe'), ['stop', '-D', data, '-m', 'immediate', '-w'], 60_000).catch(() => undefined);
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };

  try {
    const init = ['-D', data, '-U', user, '-E', 'UTF8', '--locale=C'];
    if (emptyPassword) {
      init.push('--auth=trust');
    } else {
      await fs.writeFile(pwfile, password);
      init.push('--auth=scram-sha-256', `--pwfile=${pwfile}`);
    }
    try { await run(join(bin, 'initdb.exe'), init, 120_000); } finally { await fs.rm(pwfile, { force: true }); }
    const options = `-p ${port} -h 127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`;
    await run(join(bin, 'pg_ctl.exe'), ['start', '-D', data, '-l', join(dir, 'server.log'), '-w', '-t', '60', '-o', options], 90_000);
    started = true;
  } catch (err) {
    await stop();
    throw err;
  }
  return { host: '127.0.0.1', port, user, password, stop };
}

/** Starts a throwaway server bound to 127.0.0.1 on an OS-chosen port. Always call stop() in afterAll. */
export async function startTempServer(name: ServerName, options: { emptyPassword?: boolean } = {}): Promise<TempServer> {
  if (name === 'postgres' || name === 'postgres-old') return startPostgres(name, options.emptyPassword ?? false);
  throw new Error(`Temp ${name} servers are not available yet.`);
}
