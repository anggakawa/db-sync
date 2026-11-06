import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolLocator, ToolMissingError } from '../../src/main/tools/tool-locator';
import type { Flavor } from '../../src/shared/types';

describe('createToolLocator', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dbsync-tools-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ['postgres', 'dump', 'pg_dump.exe'],
    ['postgres', 'restore', 'pg_restore.exe'],
    ['mysql', 'dump', 'mysqldump.exe'],
    ['mysql', 'restore', 'mysql.exe'],
    ['mariadb', 'dump', 'mariadb-dump.exe'],
    ['mariadb', 'restore', 'mariadb.exe'],
  ] as const)('finds %s %s', (flavor: Flavor, tool, exe) => {
    mkdirSync(join(root, flavor, 'bin'), { recursive: true });
    writeFileSync(join(root, flavor, 'bin', exe), '');
    const found = createToolLocator(root).path(flavor, tool);
    expect(found).toBe(join(root, flavor, 'bin', exe));
    expect(found.endsWith(join(flavor, "bin", exe))).toBe(true);
  });

  it('throws ToolMissingError naming the file when absent', () => {
    const locator = createToolLocator(root);
    expect(() => locator.path('mysql', 'dump')).toThrow(ToolMissingError);
    expect(() => locator.path('mysql', 'dump')).toThrow(/mysqldump\.exe/);
  });

  it("pluginDir is the lib/plugin folder for mysql and mariadb and null for postgres", () => {
    const locator = createToolLocator(root);
    expect(locator.pluginDir("mariadb")).toBe(join(root, "mariadb", "lib", "plugin"));
    expect(locator.pluginDir("mysql")).toBe(join(root, "mysql", "lib", "plugin"));
    expect(locator.pluginDir("postgres")).toBeNull();
  });
});

describe('createToolLocator PostgreSQL majors', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dbsync-tools-'));
    for (const dir of ['postgres', 'postgres-16']) {
      mkdirSync(join(root, dir, 'bin'), { recursive: true });
      writeFileSync(join(root, dir, 'bin', 'pg_dump.exe'), '');
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    [undefined, 'postgres'],
    [18, 'postgres'],
    [19, 'postgres'],
    [17, 'postgres'],
    [16, 'postgres-16'],
    [15, 'postgres-16'],
    [14, 'postgres-16'],
  ])('uses the %s server tools from %s', (major, dir) => {
    expect(createToolLocator(root).path('postgres', 'dump', major)).toBe(join(root, dir, 'bin', 'pg_dump.exe'));
  });

  it('ignores the major for MySQL and MariaDB', () => {
    mkdirSync(join(root, 'mysql', 'bin'), { recursive: true });
    writeFileSync(join(root, 'mysql', 'bin', 'mysqldump.exe'), '');
    expect(createToolLocator(root).path('mysql', 'dump', 8)).toBe(join(root, 'mysql', 'bin', 'mysqldump.exe'));
  });
});
