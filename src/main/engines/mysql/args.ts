import { join } from 'node:path';
import type { Endpoint } from '../../../shared/types';

export type MysqlFlavor = 'mysql' | 'mariadb';
export interface ToolOptions {
  flavor: MysqlFlavor;
  /** undefined leaves the mode to the tool's default (the local target). */
  ssl?: boolean;
  /** Where the MariaDB client finds its authentication plugins (ed25519...). */
  pluginDir?: string | null;
}

/** The MySQL command-line tools get arguments in the ANSI code page, so a name outside ASCII arrives mangled. */
export const hasNonAscii = (name: string): boolean => /[^\x00-\x7f]/.test(name);

export const unsupportedNameMessage = (name: string): string =>
  `MySQL's command-line tools can't handle the database name ${name}. Rename the database or use one with only English letters and numbers.`;

export const unreadableFolderMessage = (folder: string): string =>
  `MySQL's command-line tools can't read files in ${folder}, usually because the folder name has characters they don't support.`;

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

/**
 * The password, so it never appears on a command line. It is always written, empty or not: with no value in the
 * file nothing else may supply one. Host, port and user are written here too but also go on the command line.
 */
export function defaultsFileContent(e: { host: string; port: number; user: string; password: string }): string {
  const lines = ['[client]', `host=${quoted(e.host)}`, `port=${e.port}`, `user=${quoted(e.user)}`];
  lines.push(`password=${quoted(e.password)}`);
  return `${lines.join('\n')}\n`;
}

function sslArgs(o: ToolOptions): string[] {
  if (o.ssl === undefined) return [];
  if (o.flavor === 'mysql') return o.ssl ? ['--ssl-mode=REQUIRED'] : ['--ssl-mode=DISABLED', '--get-server-public-key'];
  return o.ssl ? ['--ssl', '--skip-ssl-verify-server-cert'] : ['--skip-ssl'];
}

/**
 * `--defaults-file` has to be the first argument, and it replaces the machine's option files (my.ini), where a
 * setting like `[mysql] force` would defeat stop-on-error. The server comes from the command line, which wins over
 * a login path too.
 */
function common(ep: Endpoint, defaultsFile: string, o: ToolOptions): string[] {
  const args = [
    `--defaults-file=${defaultsFile}`, `--host=${ep.host}`, `--port=${ep.port}`, '--protocol=tcp', '--default-character-set=utf8mb4', ...sslArgs(o),
  ];
  if (o.flavor === 'mariadb' && o.pluginDir) args.push(`--plugin-dir=${o.pluginDir}`);
  return args;
}

/** Never contains the password; it travels in the defaults file only. */
export function dumpArgs(ep: Endpoint, defaultsFile: string, o: ToolOptions): string[] {
  const args = [
    ...common(ep, defaultsFile, o),
    '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--no-tablespaces',
  ];
  if (o.flavor === 'mysql') args.push('--set-gtid-purged=OFF');
  // "--" so a database name that starts with a dash is not read as an option.
  return [...args, '--', ep.database];
}

/** No --force: the client stops at the first error. */
export function restoreArgs(ep: Endpoint, defaultsFile: string, o: ToolOptions): string[] {
  return [...common(ep, defaultsFile, o), `--database=${ep.database}`];
}

/**
 * MySQL clients read `%APPDATA%\MySQL\.mylogin.cnf`, whose login path would override the defaults file.
 * Pointing MYSQL_TEST_LOGIN_FILE at a file that does not exist makes them read none.
 */
export function loginFileEnv(dir: string): Record<string, string> {
  return { MYSQL_TEST_LOGIN_FILE: join(dir, 'no-such-login-file.cnf') };
}
