import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
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

/** Kills a postmaster that pg_ctl could not stop, found through its own pid file in the temp data folder. */
async function killPostmaster(data: string): Promise<void> {
  const text = await fs.readFile(join(data, 'postmaster.pid'), 'utf8').catch(() => '');
  const pid = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return;
  await run('taskkill', ['/PID', String(pid), '/T', '/F'], 30_000).catch(() => undefined);
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
    await killPostmaster(data);
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
    // Even a start that times out may have left a postmaster running, so stop() must try.
    started = true;
    await run(join(bin, 'pg_ctl.exe'), ['start', '-D', data, '-l', join(dir, 'server.log'), '-w', '-t', '60', '-o', options], 90_000);
  } catch (err) {
    const log = await fs.readFile(join(dir, 'server.log'), 'utf8').catch(() => '');
    await stop();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n--- server.log ---\n${log.slice(-4000)}`);
  }
  return { host: '127.0.0.1', port, user, password, stop };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sqlString = (value: string) => mysql.escape(value);

/** Runs a console server (mysqld, mariadbd) that stays in the foreground. stdio is ignored. */
function spawnDaemon(exe: string, args: string[]): { child: ChildProcess; exited: Promise<void> } {
  const child = spawn(exe, args, { shell: false, windowsHide: true, stdio: 'ignore', env: cleanEnv(process.env) });
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
    child.once('error', () => resolveExit());
  });
  return { child, exited };
}

async function startMysqlFamily(name: 'mysql' | 'mariadb', emptyPassword: boolean, noTls: boolean): Promise<TempServer> {
  const bin = join(REPO_ROOT, '.cache', 'servers', name, 'bin');
  const dir = await fs.mkdtemp(join(tmpdir(), `dbsync-${name}-`));
  const data = join(dir, 'data');
  const user = 'sync_test';
  const password = emptyPassword ? '' : randomBytes(12).toString('hex');
  const rootPassword = randomBytes(12).toString('hex');
  const port = await freePort();
  const mysqld = join(bin, name === 'mysql' ? 'mysqld.exe' : 'mariadbd.exe');
  let daemon: ReturnType<typeof spawnDaemon> | undefined;

  const rootConnection = () => mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: rootPassword });

  const stop = async (): Promise<void> => {
    if (daemon) {
      const { child, exited } = daemon;
      daemon = undefined;
      try {
        const root = await rootConnection();
        await root.query('SHUTDOWN').catch(() => undefined);
        root.destroy();
      } catch { /* not reachable: fall through to the kill */ }
      const gone = await Promise.race([exited.then(() => true), sleep(30_000).then(() => false)]);
      if (!gone && child.pid !== undefined) await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], 30_000).catch(() => undefined);
      await Promise.race([exited, sleep(10_000)]);
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };

  try {
    await fs.mkdir(dir, { recursive: true });
    // Every option the server runs with is explicit, and none of it listens beyond loopback.
    const common = [
      `--datadir=${data}`, `--port=${port}`, '--bind-address=127.0.0.1', `--log-error=${join(dir, 'server.log')}`,
    ];
    if (name === 'mysql') {
      await run(mysqld, ['--no-defaults', '--initialize-insecure', `--datadir=${data}`, `--log-error=${join(dir, 'init.log')}`], 180_000);
      // Without its certificates (and without generating new ones) the server has no TLS.
      if (noTls) {
        for (const file of await fs.readdir(data)) if (file.endsWith('.pem')) await fs.rm(join(data, file), { force: true });
      }
    } else {
      await run(join(bin, 'mariadb-install-db.exe'), [`--datadir=${data}`, `--port=${port}`, `--password=${rootPassword}`, '--silent'], 180_000);
    }
    const fast = ['--innodb-buffer-pool-size=64M', '--innodb-flush-log-at-trx-commit=0', '--max-connections=60'];
    const extra = name === 'mysql' ? ['--mysqlx=OFF', '--disable-log-bin'] : ['--skip-log-bin'];
    // MariaDB has no certificate configured here, so it already runs without TLS.
    if (noTls) extra.push(name === 'mysql' ? '--auto-generate-certs=OFF' : '--skip-ssl');
    // --no-defaults first: the machine's my.ini must not change how a test server runs.
    daemon = spawnDaemon(mysqld, ['--no-defaults', ...common, ...fast, ...extra]);

    const deadline = Date.now() + 90_000;
    const initialRootPassword = name === 'mysql' ? '' : rootPassword;
    let root: mysql.Connection | undefined;
    while (!root) {
      if (Date.now() > deadline) throw new Error(`${name} did not accept connections`);
      let died = false;
      void daemon.exited.then(() => { died = true; });
      try {
        root = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: initialRootPassword, connectTimeout: 3_000 });
      } catch {
        await sleep(300);
        if (died) throw new Error(`${name} exited during startup`);
      }
    }
    try {
      if (name === 'mysql') await root.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${sqlString(rootPassword)}`);
      await root.query(`CREATE USER ${sqlString(user)}@'%' IDENTIFIED BY ${sqlString(password)}`);
      await root.query(`GRANT ALL PRIVILEGES ON *.* TO ${sqlString(user)}@'%' WITH GRANT OPTION`);
    } finally {
      root.destroy();
    }
  } catch (err) {
    const log = await fs.readFile(join(dir, 'server.log'), 'utf8').catch(() => '');
    await stop();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n--- server.log ---\n${log.slice(-4000)}`);
  }
  return { host: '127.0.0.1', port, user, password, stop };
}

/** Starts a throwaway server bound to 127.0.0.1 on an OS-chosen port. Always call stop() in afterAll. */
export interface TempServerOptions { emptyPassword?: boolean; noTls?: boolean }

export async function startTempServer(name: ServerName, options: TempServerOptions = {}): Promise<TempServer> {
  if (name === 'postgres' || name === 'postgres-old') return startPostgres(name, options.emptyPassword ?? false);
  if (name === 'mysql' || name === 'mariadb') return startMysqlFamily(name, options.emptyPassword ?? false, options.noTls ?? false);
  throw new Error(`Temp ${name} servers are not available yet.`);
}

/** Starts several servers; if any fails, the ones that did start are stopped before the error is thrown. */
export async function startTempServers(...specs: Array<[ServerName, TempServerOptions?]>): Promise<TempServer[]> {
  const results = await Promise.allSettled(specs.map(([name, options]) => startTempServer(name, options)));
  const started = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    await Promise.all(started.map((s) => s.stop().catch(() => undefined)));
    throw failed.reason;
  }
  return started;
}
