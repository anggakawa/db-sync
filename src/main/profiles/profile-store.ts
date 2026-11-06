import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Endpoint, Profile, ProfileInput, ProfileView, SourceEndpoint, SyncOutcome } from '../../shared/types';

export interface Cipher { isAvailable(): boolean; encrypt(plain: string): string; decrypt(stored: string): string }

/** Which sides hold a stored password that cannot be decrypted. */
export interface UnreadablePasswords { source: boolean; target: boolean }
export interface ProfileEntry { profile: Profile; unreadable: UnreadablePasswords }

/** The stored password could not be decrypted (for example after a Windows account change). */
export class PasswordUnreadableError extends Error {
  constructor(readonly sides: UnreadablePasswords) {
    const which = sides.source && sides.target ? 'source and target' : sides.source ? 'source' : 'target';
    super(`The saved ${which} password can't be read any more. Edit this profile and enter it again.`);
    this.name = 'PasswordUnreadableError';
  }
}

/** profiles.json exists but cannot be read as a profile list. It is never overwritten. */
export class ProfilesFileCorruptError extends Error {
  constructor(readonly file: string) {
    super(`The profiles file ${file} is damaged and cannot be read. It has not been changed. Fix or delete it, then start the app again.`);
    this.name = 'ProfilesFileCorruptError';
  }
}

export interface ProfileStore {
  /** Decrypted, main process only. An unreadable password comes back as ''; use listEntries to tell. */
  list(): Promise<Profile[]>;
  listEntries(): Promise<ProfileEntry[]>;
  /** Throws PasswordUnreadableError rather than hand out a profile with a wrong (empty) password. */
  get(id: string): Promise<Profile>;
  getEntry(id: string): Promise<ProfileEntry>;
  save(input: ProfileInput): Promise<Profile>;
  remove(id: string): Promise<void>;
  setLastResult(id: string, outcome: SyncOutcome): Promise<void>;
  lastResult(id: string): Promise<SyncOutcome | null>;
}

// On disk, every password is already passed through the cipher ('' stays '').
interface FileData { profiles: Profile[]; results: Record<string, SyncOutcome> }

function validEndpoint(label: string, e: { host: string; user: string; port: number; database: string }): void {
  if (!e.host || !e.host.trim()) throw new Error(`${label} host is required`);
  if (!e.user || !e.user.trim()) throw new Error(`${label} user is required`);
  if (!e.database || !e.database.trim()) throw new Error(`${label} database is required`);
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new Error(`${label} port must be between 1 and 65535`);
}

export const NEW_HOST_PASSWORD = 'Enter the password for the new host.';

/**
 * The stored source password is reused only while the source host and port are unchanged, so a typo or an edited
 * host never receives it. A typed password, even an empty one, always wins.
 */
export function resolveSource(input: ProfileInput, existing: Profile | null): SourceEndpoint {
  validEndpoint('Source', input.source);
  let password = input.source.password;
  if (password === undefined) {
    if (existing && (existing.source.host !== input.source.host || existing.source.port !== input.source.port)) {
      throw new Error(NEW_HOST_PASSWORD);
    }
    password = existing?.source.password ?? '';
  }
  return { ...input.source, password };
}

/** The target is limited to loopback by the guard, so its stored password is kept whatever the host. */
export function resolveTarget(input: ProfileInput, existing: Profile | null): Endpoint {
  validEndpoint('Target', input.target);
  return { ...input.target, password: input.target.password ?? existing?.target.password ?? '' };
}

export function resolveInput(input: ProfileInput, existing: Profile | null): Profile {
  if (!input.name || !input.name.trim()) throw new Error('Profile name is required');
  const source = resolveSource(input, existing);
  const target = resolveTarget(input, existing);
  return {
    id: input.id ?? existing?.id ?? randomUUID(),
    name: input.name, engine: input.engine, backupEnabled: input.backupEnabled,
    source, target
  };
}

export function toView(
  p: Profile,
  extras: {
    lastResult: SyncOutcome | null; hasBackup: boolean; hasUnfinishedSync: boolean;
    passwordUnreadable?: UnreadablePasswords;
  }
): ProfileView {
  const { password: sp, ...source } = p.source;
  const { password: tp, ...target } = p.target;
  return {
    id: p.id, name: p.name, engine: p.engine, backupEnabled: p.backupEnabled,
    source: { ...source, hasPassword: sp !== '', passwordUnreadable: extras.passwordUnreadable?.source ?? false },
    target: { ...target, hasPassword: tp !== '', passwordUnreadable: extras.passwordUnreadable?.target ?? false },
    lastResult: extras.lastResult, hasBackup: extras.hasBackup, hasUnfinishedSync: extras.hasUnfinishedSync
  };
}

export function createProfileStore(filePath: string, cipher: Cipher): ProfileStore {
  let queue: Promise<unknown> = Promise.resolve();
  // Serialise operations so read-modify-write cycles never interleave.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function readFile(): Promise<FileData> {
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [], results: {} };
      throw e;
    }
    let data: Partial<FileData>;
    try {
      data = JSON.parse(text) as Partial<FileData>;
    } catch {
      throw new ProfilesFileCorruptError(filePath);
    }
    const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObject(data) || (data.profiles !== undefined && !Array.isArray(data.profiles)) ||
        (data.results !== undefined && !isObject(data.results))) {
      throw new ProfilesFileCorruptError(filePath);
    }
    const str = (v: unknown) => typeof v === 'string';
    const endpointOk = (v: unknown) => isObject(v) && str((v as Endpoint).host) && str((v as Endpoint).user) &&
      str((v as Endpoint).database) && typeof (v as Endpoint).port === 'number' && str((v as Endpoint).password);
    const entryOk = (v: unknown) => isObject(v) && str((v as Profile).id) && str((v as Profile).name) &&
      ((v as Profile).engine === 'postgres' || (v as Profile).engine === 'mysql') &&
      endpointOk((v as Profile).source) && endpointOk((v as Profile).target);
    if (!(data.profiles ?? []).every(entryOk)) throw new ProfilesFileCorruptError(filePath);
    return { profiles: data.profiles ?? [], results: data.results ?? {} };
  }

  async function writeFile(data: FileData): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, filePath);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  const enc = (plain: string): string => {
    if (plain === '') return '';
    if (!cipher.isAvailable()) throw new Error('Password encryption is not available on this system, so a password cannot be saved');
    return cipher.encrypt(plain);
  };
  // A password that cannot be decrypted becomes '' and is flagged, so one bad entry never hides the others.
  const dec = (stored: string): { plain: string; unreadable: boolean } => {
    if (stored === '') return { plain: '', unreadable: false };
    try {
      return { plain: cipher.decrypt(stored), unreadable: false };
    } catch {
      return { plain: '', unreadable: true };
    }
  };
  const decryptEntry = (p: Profile): ProfileEntry => {
    const s = dec(p.source.password);
    const t = dec(p.target.password);
    return {
      profile: { ...p, source: { ...p.source, password: s.plain }, target: { ...p.target, password: t.plain } },
      unreadable: { source: s.unreadable, target: t.unreadable }
    };
  };
  const decrypt = (p: Profile): Profile => decryptEntry(p).profile;
  const encrypt = (p: Profile): Profile => ({
    ...p,
    source: { ...p.source, password: enc(p.source.password) },
    target: { ...p.target, password: enc(p.target.password) }
  });

  return {
    list: () => serial(async () => (await readFile()).profiles.map(decrypt)),
    listEntries: () => serial(async () => (await readFile()).profiles.map(decryptEntry)),
    getEntry: (id) => serial(async () => {
      const found = (await readFile()).profiles.find((p) => p.id === id);
      if (!found) throw new Error(`Profile not found: ${id}`);
      return decryptEntry(found);
    }),
    get: (id) => serial(async () => {
      const found = (await readFile()).profiles.find((p) => p.id === id);
      if (!found) throw new Error(`Profile not found: ${id}`);
      const entry = decryptEntry(found);
      if (entry.unreadable.source || entry.unreadable.target) throw new PasswordUnreadableError(entry.unreadable);
      return entry.profile;
    }),
    save: (input) => serial(async () => {
      const data = await readFile();
      const stored = input.id ? data.profiles.find((p) => p.id === input.id) : undefined;
      const entry = stored ? decryptEntry(stored) : null;
      const profile = resolveInput(input, entry?.profile ?? null);
      const encrypted = encrypt(profile);
      // A password that cannot be read right now is written back untouched, not replaced by an empty one.
      if (stored && entry) {
        if (input.source.password === undefined && entry.unreadable.source) encrypted.source.password = stored.source.password;
        if (input.target.password === undefined && entry.unreadable.target) encrypted.target.password = stored.target.password;
      }
      const i = data.profiles.findIndex((p) => p.id === profile.id);
      if (i >= 0) data.profiles[i] = encrypted; else data.profiles.push(encrypted);
      await writeFile(data);
      return profile;
    }),
    remove: (id) => serial(async () => {
      const data = await readFile();
      data.profiles = data.profiles.filter((p) => p.id !== id);
      delete data.results[id];
      await writeFile(data);
    }),
    setLastResult: (id, outcome) => serial(async () => {
      const data = await readFile();
      if (!data.profiles.some((p) => p.id === id)) return; // removed meanwhile: do not write an orphan
      data.results[id] = outcome;
      await writeFile(data);
    }),
    lastResult: (id) => serial(async () => (await readFile()).results[id] ?? null)
  };
}
