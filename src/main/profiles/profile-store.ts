import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Endpoint, Profile, ProfileInput, ProfileView, SourceEndpoint, SyncOutcome } from '../../shared/types';

export interface Cipher { isAvailable(): boolean; encrypt(plain: string): string; decrypt(stored: string): string }

export interface ProfileStore {
  list(): Promise<Profile[]>; // decrypted, main process only
  get(id: string): Promise<Profile>;
  save(input: ProfileInput): Promise<Profile>;
  remove(id: string): Promise<void>;
  setLastResult(id: string, outcome: SyncOutcome): Promise<void>;
  lastResult(id: string): Promise<SyncOutcome | null>;
}

// On disk, every password is already passed through the cipher ('' stays '').
interface FileData { profiles: Profile[]; results: Record<string, SyncOutcome> }

function validEndpoint(label: string, e: { port: number; database: string }): void {
  if (!e.database || !e.database.trim()) throw new Error(`${label} database is required`);
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new Error(`${label} port must be between 1 and 65535`);
}

export function resolveInput(input: ProfileInput, existing: Profile | null): Profile {
  if (!input.name || !input.name.trim()) throw new Error('Profile name is required');
  validEndpoint('Source', input.source);
  validEndpoint('Target', input.target);
  const source: SourceEndpoint = { ...input.source, password: input.source.password ?? existing?.source.password ?? '' };
  const target: Endpoint = { ...input.target, password: input.target.password ?? existing?.target.password ?? '' };
  return {
    id: input.id ?? existing?.id ?? randomUUID(),
    name: input.name, engine: input.engine, backupEnabled: input.backupEnabled,
    source, target
  };
}

export function toView(
  p: Profile,
  extras: { lastResult: SyncOutcome | null; hasBackup: boolean; hasUnfinishedSync: boolean }
): ProfileView {
  const { password: sp, ...source } = p.source;
  const { password: tp, ...target } = p.target;
  return {
    id: p.id, name: p.name, engine: p.engine, backupEnabled: p.backupEnabled,
    source: { ...source, hasPassword: sp !== '' },
    target: { ...target, hasPassword: tp !== '' },
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
    const data = JSON.parse(text) as Partial<FileData>;
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
  const dec = (stored: string): string => (stored === '' ? '' : cipher.decrypt(stored));
  const decrypt = (p: Profile): Profile => ({
    ...p,
    source: { ...p.source, password: dec(p.source.password) },
    target: { ...p.target, password: dec(p.target.password) }
  });
  const encrypt = (p: Profile): Profile => ({
    ...p,
    source: { ...p.source, password: enc(p.source.password) },
    target: { ...p.target, password: enc(p.target.password) }
  });

  return {
    list: () => serial(async () => (await readFile()).profiles.map(decrypt)),
    get: (id) => serial(async () => {
      const found = (await readFile()).profiles.find((p) => p.id === id);
      if (!found) throw new Error(`Profile not found: ${id}`);
      return decrypt(found);
    }),
    save: (input) => serial(async () => {
      const data = await readFile();
      const stored = input.id ? data.profiles.find((p) => p.id === input.id) : undefined;
      const profile = resolveInput(input, stored ? decrypt(stored) : null);
      const encrypted = encrypt(profile);
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
      data.results[id] = outcome;
      await writeFile(data);
    }),
    lastResult: (id) => serial(async () => (await readFile()).results[id] ?? null)
  };
}
