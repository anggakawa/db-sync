import type { SyncStep } from '../../shared/types';
import type { ServerInfo } from '../engines/adapter';
import { ToolError } from '../process/process-runner';

const FLAVOR_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' } as const;

const COPY: Record<SyncStep, { what: string; next: string }> = {
  check: { what: 'The checks before the sync', next: 'Check the connection details and try again.' },
  download: { what: 'Downloading from dev', next: 'Nothing local was changed. Check that dev is reachable, then try again.' },
  backup: { what: 'Backing up local data', next: 'Nothing local was changed. Free some disk space or turn off the backup, then try again.' },
  replace: { what: 'Replacing the local database', next: 'Try the sync again, and open the log for the full error.' },
  verify: { what: 'Checking the local copy', next: 'Run the sync again if the local data looks wrong.' },
};

const isOlder = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

export function describeFailure(
  step: SyncStep, error: unknown, source: ServerInfo | null, target: ServerInfo | null,
): { message: string; details: string } {
  const tool = error instanceof ToolError ? error : null;
  const details = tool
    ? (tool.stderrTail.trim() || tool.message)
    : error instanceof Error ? (error.stack ?? error.message) : String(error);

  if (step === 'replace' && tool && source && target && source.flavor === target.flavor && isOlder(target.version, source.version)) {
    return {
      message: `Local ${FLAVOR_LABEL[target.flavor]} ${target.versionLabel} can't load this dump from dev ${source.versionLabel}. Upgrade your local image.`,
      details,
    };
  }
  const lastLine = tool ? tool.stderrTail.trim().split(/\r?\n/).filter(Boolean).pop() : undefined;
  const reason = (lastLine ?? (error instanceof Error ? error.message : String(error))).replace(/[.\s]+$/, '');
  const { what, next } = COPY[step];
  return { message: `${what} failed: ${reason}. ${next}`, details };
}
