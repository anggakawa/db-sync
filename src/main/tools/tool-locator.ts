import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Flavor } from '../../shared/types';

export type ToolName = 'dump' | 'restore';

export class ToolMissingError extends Error {
  constructor(file: string) {
    super(`Bundled tool not found: ${file}`);
    this.name = 'ToolMissingError';
  }
}

export interface ToolLocator {
  path(flavor: Flavor, tool: ToolName): string;
  /** Folder to pass as --plugin-dir (mariadb client auth plugins); null when the flavor has none. */
  pluginDir(flavor: Flavor): string | null;
}

const EXECUTABLES: Record<Flavor, Record<ToolName, string>> = {
  postgres: { dump: 'pg_dump.exe', restore: 'pg_restore.exe' },
  mysql: { dump: 'mysqldump.exe', restore: 'mysql.exe' },
  mariadb: { dump: 'mariadb-dump.exe', restore: 'mariadb.exe' },
};

export function createToolLocator(toolsRoot: string): ToolLocator {
  return {
    path(flavor, tool) {
      const file = join(toolsRoot, flavor, 'bin', EXECUTABLES[flavor][tool]);
      if (!existsSync(file)) throw new ToolMissingError(file);
      return file;
    },
    pluginDir(flavor) {
      return flavor === 'mariadb' ? join(toolsRoot, flavor, 'lib', 'plugin') : null;
    },
  };
}
