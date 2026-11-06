import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { CHANNELS, PROFILE_ID, type ConnectionSide } from '../shared/api';
import type { ProfileInput } from '../shared/types';
import type { SyncService } from './sync/sync-service';

const fail = (what: string): never => { throw new Error(`Invalid request: ${what}`); };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The object has these keys and no others. Optional keys may be missing or undefined. */
function shape(v: unknown, what: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isRecord(v)) return fail(`${what} must be an object`);
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) fail(`${what} must be a plain object`);
  for (const key of Object.keys(v)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${what} has an unexpected field "${key}"`);
  }
  for (const key of required) if (!(key in v)) fail(`${what} is missing "${key}"`);
  return v;
}
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : fail(`${what} must be text`));
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : fail(`${what} must be true or false`));
const port = (v: unknown, what: string): number =>
  (typeof v === 'number' && Number.isInteger(v) ? v : fail(`${what} must be a whole number`));
const optionalStr = (v: unknown, what: string): string | undefined => (v === undefined ? undefined : str(v, what));

export function parseId(v: unknown): string {
  return typeof v === 'string' && PROFILE_ID.test(v) ? v : fail('profile id');
}
export function parseSide(v: unknown): ConnectionSide {
  return v === 'source' || v === 'target' ? v : fail('side must be source or target');
}
export function parseAccept(v: unknown): boolean {
  return bool(v, 'answer');
}
export function parseProfileInput(v: unknown): ProfileInput {
  const o = shape(v, 'profile', ['name', 'engine', 'backupEnabled', 'source', 'target'], ['id']);
  const engine = o['engine'];
  if (engine !== 'postgres' && engine !== 'mysql') fail('engine must be postgres or mysql');
  const s = shape(o['source'], 'source', ['host', 'port', 'user', 'database', 'ssl'], ['password']);
  const t = shape(o['target'], 'target', ['host', 'port', 'user', 'database'], ['password']);
  const input: ProfileInput = {
    name: str(o['name'], 'name'),
    engine: engine as ProfileInput['engine'],
    backupEnabled: bool(o['backupEnabled'], 'backupEnabled'),
    source: {
      host: str(s['host'], 'source host'), port: port(s['port'], 'source port'), user: str(s['user'], 'source user'),
      database: str(s['database'], 'source database'), ssl: bool(s['ssl'], 'source ssl'),
    },
    target: {
      host: str(t['host'], 'target host'), port: port(t['port'], 'target port'), user: str(t['user'], 'target user'),
      database: str(t['database'], 'target database'),
    },
  };
  if (o['id'] !== undefined) input.id = parseId(o['id']);
  const sp = optionalStr(s['password'], 'source password');
  const tp = optionalStr(t['password'], 'target password');
  if (sp !== undefined) input.source.password = sp;
  if (tp !== undefined) input.target.password = tp;
  return input;
}

/**
 * One handler per channel in CHANNELS, each checking who is asking and the exact shape of the arguments.
 * Returns a function that removes every handler.
 */
export function registerIpc(ipc: IpcMain, service: SyncService, isTrusted: (e: IpcMainInvokeEvent) => boolean): () => void {
  const handle = (channel: string, argc: number, fn: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrusted(event)) throw new Error('Request not allowed.');
      if (args.length !== argc) fail(`${channel} takes ${argc} argument(s)`);
      return fn(...args);
    });
  };
  handle(CHANNELS.listProfiles, 0, () => service.listProfiles());
  handle(CHANNELS.saveProfile, 1, (i) => service.saveProfile(parseProfileInput(i)));
  handle(CHANNELS.deleteProfile, 1, (id) => service.deleteProfile(parseId(id)));
  handle(CHANNELS.testConnection, 2, (i, side) => service.testConnection(parseProfileInput(i), parseSide(side)));
  handle(CHANNELS.startSync, 1, (id) => service.startSync(parseId(id)));
  handle(CHANNELS.restoreBackup, 1, (id) => service.restoreBackup(parseId(id)));
  handle(CHANNELS.recover, 1, (id) => service.recover(parseId(id)));
  handle(CHANNELS.cancel, 0, () => service.cancel());
  handle(CHANNELS.answerWarnings, 1, (accept) => service.answerWarnings(parseAccept(accept)));
  return () => {
    for (const channel of Object.values(CHANNELS)) ipc.removeHandler(channel);
  };
}
