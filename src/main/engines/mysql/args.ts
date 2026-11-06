import type { Endpoint } from '../../../shared/types';

export type MysqlFlavor = 'mysql' | 'mariadb';
export interface ToolOptions {
  flavor: MysqlFlavor;
  /** undefined leaves the mode to the tool's default (the local target). */
  ssl?: boolean;
  /** Where the MariaDB client finds its authentication plugins (ed25519...). */
  pluginDir?: string | null;
}

export function parseServerVersion(text: string): { flavor: MysqlFlavor; version: [number, number]; versionLabel: string } {
  const flavor: MysqlFlavor = /mariadb/i.test(text) ? 'mariadb' : 'mysql';
  // Some MariaDB servers report a "5.5.5-" prefix for old clients.
  const match = /^(?:5\.5\.5-)?(\d+)\.(\d+)/.exec(text.trim());
  if (!match) throw new Error(`Unrecognised server version: ${text}`);
  const version: [number, number] = [Number(match[1]), Number(match[2])];
  return { flavor, version, versionLabel: `${version[0]}.${version[1]}` };
}

/** A double-quoted option-file value; only backslash, quote and line breaks need escaping. */
function quoted(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
  return `"${escaped}"`;
}

/** The connection details, so the password never appears on a command line. The password line is left out when empty. */
export function defaultsFileContent(e: { host: string; port: number; user: string; password: string }): string {
  const lines = ['[client]', `host=${quoted(e.host)}`, `port=${e.port}`, `user=${quoted(e.user)}`];
  if (e.password !== '') lines.push(`password=${quoted(e.password)}`);
  return `${lines.join('\n')}\n`;
}

function sslArgs(o: ToolOptions): string[] {
  if (o.ssl === undefined) return [];
  if (o.flavor === 'mysql') return [o.ssl ? '--ssl-mode=REQUIRED' : '--ssl-mode=DISABLED'];
  return o.ssl ? ['--ssl', '--skip-ssl-verify-server-cert'] : ['--skip-ssl'];
}

/** `--defaults-extra-file` has to be the first argument or the tool rejects it. */
function common(defaultsFile: string, o: ToolOptions): string[] {
  const args = [`--defaults-extra-file=${defaultsFile}`, '--protocol=tcp', '--default-character-set=utf8mb4', ...sslArgs(o)];
  if (o.flavor === 'mariadb' && o.pluginDir) args.push(`--plugin-dir=${o.pluginDir}`);
  return args;
}

/** Never contains the password; it travels in the defaults file only. */
export function dumpArgs(ep: Endpoint, defaultsFile: string, o: ToolOptions): string[] {
  const args = [
    ...common(defaultsFile, o),
    '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--no-tablespaces',
  ];
  if (o.flavor === 'mysql') args.push('--set-gtid-purged=OFF');
  // "--" so a database name that starts with a dash is not read as an option.
  return [...args, '--', ep.database];
}

/** No --force: the client stops at the first error. */
export function restoreArgs(ep: Endpoint, defaultsFile: string, o: ToolOptions): string[] {
  return [...common(defaultsFile, o), `--database=${ep.database}`];
}
