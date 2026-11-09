import { SyncBusyError } from '../shared/api';

/** An error from the main process arrives as "Error invoking remote method '...': Error: message"; only the message is for people. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '');
}

/** SyncBusyError crosses IPC as a message only, so it is recognised by its text. */
export function isBusyError(err: unknown): boolean {
  return errorMessage(err).includes(new SyncBusyError().message);
}
