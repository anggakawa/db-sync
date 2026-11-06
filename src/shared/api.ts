import type { CheckIssue, Flavor, ProfileInput, ProfileView, SyncEvent, SyncOutcome } from './types';

export type ConnectionSide = 'source' | 'target';
export type ConnectionTestResult = { ok: true; versionLabel: string; flavor: Flavor } | { ok: false; message: string };

export interface DbSyncApi {
  listProfiles(): Promise<ProfileView[]>;
  saveProfile(input: ProfileInput): Promise<ProfileView>;
  deleteProfile(id: string): Promise<void>;
  testConnection(input: ProfileInput, side: ConnectionSide): Promise<ConnectionTestResult>;
  startSync(id: string): Promise<SyncOutcome>;
  restoreBackup(id: string): Promise<SyncOutcome>;
  recover(id: string): Promise<SyncOutcome>;
  cancel(): Promise<void>;
  answerWarnings(accept: boolean): Promise<void>;
  onSyncEvent(handler: (profileId: string, event: SyncEvent) => void): () => void;
  onWarnings(handler: (profileId: string, issues: CheckIssue[]) => void): () => void;
}

/** Another sync, restore or recovery is already running. Across IPC only the message survives. */
export class SyncBusyError extends Error {
  constructor(message = 'Another sync is already running. Wait for it to finish.') {
    super(message);
    this.name = 'SyncBusyError';
  }
}

/** The only channels the renderer can reach. */
export const CHANNELS = {
  listProfiles: 'dbsync:listProfiles',
  saveProfile: 'dbsync:saveProfile',
  deleteProfile: 'dbsync:deleteProfile',
  testConnection: 'dbsync:testConnection',
  startSync: 'dbsync:startSync',
  restoreBackup: 'dbsync:restoreBackup',
  recover: 'dbsync:recover',
  cancel: 'dbsync:cancel',
  answerWarnings: 'dbsync:answerWarnings',
  syncEvent: 'dbsync:syncEvent',
  warnings: 'dbsync:warnings',
} as const;

/** Profile ids become folder and file names, so only this shape is accepted. */
export const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

declare global {
  interface Window { dbSync: DbSyncApi }
}
