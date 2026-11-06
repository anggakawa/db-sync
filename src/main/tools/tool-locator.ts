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
  /**
   * `serverMajor` is the major version of the server the tool will talk to. Only PostgreSQL uses it, because its tools
   * must match the server: pg_dump refuses a server newer than itself, and newer tools write SET commands that an older
   * server rejects under --exit-on-error. Without it, or for a server newer than every bundled version, the newest is used.
   */
  path(flavor: Flavor, tool: ToolName, serverMajor?: number): string;
  /** Folder to pass as --plugin-dir (client authentication plugins); null when the flavor has none. */
  pluginDir(flavor: Flavor): string | null;
}

const EXECUTABLES: Record<Flavor, Record<ToolName, string>> = {
  postgres: { dump: 'pg_dump.exe', restore: 'pg_restore.exe' },
  mysql: { dump: 'mysqldump.exe', restore: 'mysql.exe' },
  mariadb: { dump: 'mariadb-dump.exe', restore: 'mariadb.exe' },
};

/** Older PostgreSQL majors bundled beside the newest one, in resources/tools/postgres-<major>. */
export const OLDER_POSTGRES_MAJORS: readonly number[] = [14];

function folderFor(flavor: Flavor, serverMajor?: number): string {
  if (flavor !== 'postgres' || serverMajor === undefined) return flavor;
  // The oldest bundled major that is not older than the server; servers newer than all of them use the newest tools.
  const older = OLDER_POSTGRES_MAJORS.filter((m) => m >= serverMajor).sort((a, b) => a - b)[0];
  return older === undefined ? flavor : `${flavor}-${older}`;
}

export function createToolLocator(toolsRoot: string): ToolLocator {
  return {
    path(flavor, tool, serverMajor) {
      const file = join(toolsRoot, folderFor(flavor, serverMajor), 'bin', EXECUTABLES[flavor][tool]);
      if (!existsSync(file)) throw new ToolMissingError(file);
      return file;
    },
    pluginDir(flavor) {
      return flavor === 'postgres' ? null : join(toolsRoot, flavor, 'lib', 'plugin');
    },
  };
}
