import { describe, expect, it } from 'vitest';
import {
  defaultsFileContent, dumpArgs, hasNonAscii, loginFileEnv, parseServerVersion, restoreArgs, unreadableFolderMessage, unsupportedNameMessage,
 } from '../../src/main/engines/mysql/args';
import type { Endpoint } from '../../src/shared/types';

const ep: Endpoint = { host: 'db.example.com', port: 3307, user: 'me', password: 's3cret-pw', database: 'order-db test' };
const FILE = 'C:\\tmp\\my.cnf';

describe('parseServerVersion', () => {
  it.each([
    ['8.4.2', 'mysql', [8, 4], '8.4'],
    ['8.0.36-0ubuntu0.22.04.1', 'mysql', [8, 0], '8.0'],
    ['10.11.6-MariaDB-log', 'mariadb', [10, 11], '10.11'],
    ['11.4.2-MariaDB-ubu2404', 'mariadb', [11, 4], '11.4'],
    ['5.5.5-10.6.12-MariaDB', 'mariadb', [10, 6], '10.6'],
  ])('parses %s', (text, flavor, version, label) => {
    expect(parseServerVersion(text)).toEqual({ flavor, version, versionLabel: label });
  });
  it('rejects text that is not a version', () => {
    expect(() => parseServerVersion('hello')).toThrow(/version/);
  });
});

describe('defaultsFileContent', () => {
  it('escapes quotes and backslashes in the defaults file', () =>
    expect(defaultsFileContent({ host: 'h', port: 1, user: 'u', password: 'a"b\\c' })).toContain('password="a\\"b\\\\c"'));
  it('escapes line breaks so a value cannot start a new option', () => {
    const text = defaultsFileContent({ host: 'h', port: 1, user: 'u', password: 'x\n[mysqld]\r\ny' });
    expect(text.split('\n')).toEqual(['[client]', 'host="h"', 'port=1', 'user="u"', 'password="x\\n[mysqld]\\r\\ny"', '']);
  });
  it('writes an empty password explicitly so nothing else can supply one', () => {
    const text = defaultsFileContent({ host: 'h', port: 1, user: 'u', password: '' });
    expect(text.split('\n')).toContain('password=""');
    expect(text).toContain('user="u"');
  });
});

describe('tool arguments', () => {
  const mysql = { flavor: 'mysql' as const };
  const mariadb = { flavor: 'mariadb' as const };

  it('puts --defaults-file first (never --defaults-extra-file) and never includes the password', () => {
    for (const o of [mysql, mariadb, { ...mysql, ssl: true }, { ...mariadb, ssl: false, pluginDir: 'C:\\p' }]) {
      for (const args of [dumpArgs(ep, FILE, o), restoreArgs(ep, FILE, o)]) {
        expect(args[0]).toBe(`--defaults-file=${FILE}`);
        expect(args.some((a) => a.startsWith('--defaults-extra-file'))).toBe(false);
        expect(args.join(' ')).not.toContain('s3cret-pw');
      }
    }
  });
  it('puts host and port on the command line, and the user only in the defaults file', () => {
    for (const args of [dumpArgs(ep, FILE, mysql), restoreArgs(ep, FILE, mariadb)]) {
      expect(args).toEqual(expect.arrayContaining(['--host=db.example.com', '--port=3307']));
      expect(args.some((a) => a.startsWith('--user'))).toBe(false); // mysqldump takes non-ASCII argv as raw bytes
    }
  });
  it('points MYSQL_TEST_LOGIN_FILE at a file that does not exist', () => {
    const env = loginFileEnv('C:\\tmp');
    expect(Object.keys(env)).toEqual(['MYSQL_TEST_LOGIN_FILE']);
    expect(env.MYSQL_TEST_LOGIN_FILE.startsWith('C:\\tmp')).toBe(true);
  });
  it('uses the required dump options', () => {
    expect(dumpArgs(ep, FILE, mysql)).toEqual(expect.arrayContaining([
      '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--no-tablespaces',
      '--default-character-set=utf8mb4', '--protocol=tcp',
    ]));
  });
  it('ends the dump with the database name after --', () => {
    expect(dumpArgs(ep, FILE, mysql).slice(-2)).toEqual(['--', 'order-db test']);
  });
  it('restores into the database without --force', () => {
    const args = restoreArgs(ep, FILE, mysql);
    expect(args).toEqual(expect.arrayContaining(['--database=order-db test', '--default-character-set=utf8mb4', '--protocol=tcp']));
    expect(args.some((a) => a === '-f' || a === '--force')).toBe(false);
  });
  it('adds --set-gtid-purged=OFF for mysql only', () => {
    expect(dumpArgs(ep, FILE, mysql)).toContain('--set-gtid-purged=OFF');
    expect(dumpArgs(ep, FILE, mariadb)).not.toContain('--set-gtid-purged=OFF');
  });
  it('builds the ssl flags per flavor', () => {
    expect(dumpArgs(ep, FILE, { ...mysql, ssl: false })).toContain('--ssl-mode=DISABLED');
    expect(dumpArgs(ep, FILE, { ...mysql, ssl: false })).toContain('--get-server-public-key'); // no TLS: do not rely on the server's auth cache
    expect(dumpArgs(ep, FILE, { ...mysql, ssl: true })).not.toContain('--get-server-public-key');
    expect(dumpArgs(ep, FILE, { ...mariadb, ssl: false })).not.toContain('--get-server-public-key');
    expect(dumpArgs(ep, FILE, { ...mysql, ssl: true })).toContain('--ssl-mode=REQUIRED');
    expect(dumpArgs(ep, FILE, { ...mariadb, ssl: true })).toEqual(expect.arrayContaining(['--ssl', '--skip-ssl-verify-server-cert']));
    expect(dumpArgs(ep, FILE, { ...mariadb, ssl: false })).toContain('--skip-ssl');
    for (const o of [mysql, mariadb]) {
      expect(dumpArgs(ep, FILE, o).filter((a) => /ssl/.test(a))).toEqual([]);
    }
  });
  it('passes --plugin-dir for mariadb only', () => {
    expect(restoreArgs(ep, FILE, { ...mariadb, pluginDir: 'C:\\plugins' })).toContain('--plugin-dir=C:\\plugins');
    expect(restoreArgs(ep, FILE, { ...mysql, pluginDir: 'C:\\plugins' }).some((a) => a.startsWith('--plugin-dir'))).toBe(false);
    expect(restoreArgs(ep, FILE, mariadb).some((a) => a.startsWith('--plugin-dir'))).toBe(false);
  });
});

describe('what the MySQL tools cannot take', () => {
  it.each([['dev_app', false], ['order-db test', false], ['café', true], ['データ', true], ['d\u00e9v', true]])('%s non-ASCII: %s', (name, expected) => {
    expect(hasNonAscii(name)).toBe(expected);
  });
  it('words the two blockers', () => {
    expect(unsupportedNameMessage('café')).toBe(
      "MySQL's command-line tools can't handle the database name café. Rename the database or use one with only English letters and numbers.");
    expect(unreadableFolderMessage('C:/data')).toBe(
      "MySQL's command-line tools can't read files in C:/data, usually because the folder name has characters they don't support.");
  });
});
