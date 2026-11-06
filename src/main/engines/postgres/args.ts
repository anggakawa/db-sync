import type { Endpoint } from '../../../shared/types';

export const PG_WORKERS = 4;

/** A libpq conninfo value: single-quoted, with backslashes and quotes escaped. */
export function conninfoDbname(name: string): string {
  const escaped = name.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  return `dbname='${escaped}'`;
}

const connection = (ep: Endpoint): string[] => [
  `--host=${ep.host}`, `--port=${ep.port}`, `--username=${ep.user}`, `--dbname=${conninfoDbname(ep.database)}`,
];

/** Never contains the password; it travels in PGPASSWORD only. */
export function dumpArgs(ep: Endpoint, destDir: string): string[] {
  return [
    ...connection(ep), '--format=directory', `--jobs=${PG_WORKERS}`, '--no-password', '--verbose', `--file=${destDir}`,
  ];
}

export function restoreArgs(ep: Endpoint, dumpDir: string): string[] {
  return [
    ...connection(ep), `--jobs=${PG_WORKERS}`, '--no-owner', '--no-privileges', '--exit-on-error', '--no-password',
    '--verbose', dumpDir,
  ];
}

/** `ssl` undefined leaves the mode to the tool's default (the local target). PGPASSWORD is left out when empty. */
export function toolEnv(ep: Endpoint, ssl?: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  if (ep.password !== '') env.PGPASSWORD = ep.password;
  if (ssl !== undefined) env.PGSSLMODE = ssl ? 'require' : 'disable';
  return env;
}

/** Extensions the source uses that the target server cannot create. plpgsql is always present. */
export function missingExtensions(sourceNames: string[], targetAvailable: string[]): string[] {
  const have = new Set(targetAvailable);
  return sourceNames.filter((n) => n !== 'plpgsql' && !have.has(n));
}
