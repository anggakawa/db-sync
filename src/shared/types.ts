export type Engine = 'postgres' | 'mysql';
export type Flavor = 'postgres' | 'mysql' | 'mariadb';
export type SyncStep = 'check' | 'download' | 'backup' | 'replace' | 'verify';

export interface Endpoint { host: string; port: number; user: string; password: string; database: string }
export interface SourceEndpoint extends Endpoint { ssl: boolean }
export interface Profile {
  id: string; name: string; engine: Engine;
  source: SourceEndpoint; target: Endpoint; backupEnabled: boolean;
}

export interface CheckIssue { severity: 'blocker' | 'warning'; code: string; message: string }
export type TargetState =
  | 'untouched' | 'replaced' | 'restored-from-backup' | 'removed-partial'
  | 'maybe-incomplete' | 'recovery-failed';
export type SyncOutcome =
  | { status: 'success'; durationMs: number; warnings: CheckIssue[];
      targetState: 'replaced' | 'restored-from-backup' | 'removed-partial' } // the last two come from restoreBackup and recover
  | { status: 'cancelled'; targetState: TargetState; backupPath?: string }
  | { status: 'failed'; step: SyncStep; message: string; details: string;
      targetState: TargetState; backupPath?: string };
export type SyncEvent =
  | { type: 'step'; step: SyncStep }
  | { type: 'progress'; label: string; percent: number | null }
  | { type: 'log'; line: string };

/** `passwordUnreadable`: a password is stored but cannot be decrypted any more, so it has to be entered again. */
type PublicEndpoint<E> = Omit<E, 'password'> & { hasPassword: boolean; passwordUnreadable: boolean };
export interface ProfileView {
  id: string; name: string; engine: Engine; backupEnabled: boolean;
  source: PublicEndpoint<SourceEndpoint>; target: PublicEndpoint<Endpoint>;
  lastResult: SyncOutcome | null; hasBackup: boolean; hasUnfinishedSync: boolean;
  /** The folder holding the saved backup of the local data, or null when there is none. */
  backupPath: string | null;
}
export interface ProfileInput {
  id?: string; name: string; engine: Engine; backupEnabled: boolean;
  source: Omit<SourceEndpoint, 'password'> & { password?: string }; // undefined keeps the stored password
  target: Omit<Endpoint, 'password'> & { password?: string };
}
