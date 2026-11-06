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

  it("pluginDir is the mariadb lib/plugin folder and null for other flavors", () => {
    const locator = createToolLocator(root);
    expect(locator.pluginDir("mariadb")).toBe(join(root, "mariadb", "lib", "plugin"));
    expect(locator.pluginDir("mysql")).toBeNull();
    expect(locator.pluginDir("postgres")).toBeNull();
  });
});
