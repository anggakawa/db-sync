import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProfileStore, PasswordUnreadableError, toView, type Cipher } from '../../src/main/profiles/profile-store';
import type { ProfileInput, SyncOutcome } from '../../src/shared/types';

function fakeCipher(available = true): Cipher {
  return {
    isAvailable: () => available,
    encrypt: (p) => `enc:${Buffer.from(p).toString('base64')}`,
    decrypt: (s) => Buffer.from(s.replace(/^enc:/, ''), 'base64').toString()
  };
}

function input(over: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: 'Dev', engine: 'postgres', backupEnabled: true,
    source: { host: 'dev.example.com', port: 5432, user: 'ro', password: 'hunter2', database: 'app', ssl: true },
    target: { host: 'localhost', port: 5433, user: 'me', password: 'hunter2', database: 'app' },
    ...over
  };
}

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-store-'));
  file = path.join(dir, 'profiles.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('profile store', () => {
  it('never writes a plain password to disk', async () => {
    const store = createProfileStore(file, fakeCipher());
    await store.save(input());
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('enc:');
  });

  it('round-trips passwords through the cipher', async () => {
    const store = createProfileStore(file, fakeCipher());
    const saved = await store.save(input());
    const got = await store.get(saved.id);
    expect(got.source.password).toBe('hunter2');
    expect(got.target.password).toBe('hunter2');
    expect((await store.list())).toEqual([saved]);
  });

  it('keeps the stored password when input.password is undefined', async () => {
    const store = createProfileStore(file, fakeCipher());
    const saved = await store.save(input());
    const i = input({ id: saved.id, name: 'Renamed' });
    delete i.source.password;
    delete i.target.password;
    const again = await store.save(i);
    expect(again.name).toBe('Renamed');
    expect(again.source.password).toBe('hunter2');
    expect((await store.get(saved.id)).target.password).toBe('hunter2');
  });

  it('stores an empty password when input.password is ""', async () => {
    const store = createProfileStore(file, fakeCipher());
    const saved = await store.save(input());
    const i = input({ id: saved.id });
    i.target.password = '';
    await store.save(i);
    expect((await store.get(saved.id)).target.password).toBe('');
    expect((await store.get(saved.id)).source.password).toBe('hunter2');
  });

  it('refuses to save a non-empty password when encryption is unavailable', async () => {
    const good = createProfileStore(file, fakeCipher());
    await good.save(input({ name: 'Existing' }));
    const before = await fs.readFile(file, 'utf8');
    const store = createProfileStore(file, fakeCipher(false));
    await expect(store.save(input())).rejects.toThrow(/encrypt/i);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('allows empty passwords when encryption is unavailable', async () => {
    const store = createProfileStore(file, fakeCipher(false));
    const i = input();
    i.source.password = '';
    i.target.password = '';
    const saved = await store.save(i);
    expect((await store.get(saved.id)).source.password).toBe('');
  });

  it('toView exposes hasPassword and has no password key anywhere', async () => {
    const store = createProfileStore(file, fakeCipher());
    const saved = await store.save(input());
    const view = toView(saved, { lastResult: null, hasBackup: false, hasUnfinishedSync: false });
    expect(view.source.hasPassword).toBe(true);
    expect(view.target.hasPassword).toBe(true);
    const json = JSON.stringify(view);
    expect(json).not.toContain('password"');
    expect(json).not.toContain('hunter2');
  });

  it('writes atomically', async () => {
    const store = createProfileStore(file, fakeCipher());
    await store.save(input({ name: 'First' }));
    const before = await fs.readFile(file, 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.save(input({ name: 'Second' }))).rejects.toThrow('disk full');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await store.list()).map((p) => p.name)).toEqual(['First']);
    expect((await fs.readdir(dir)).filter((f) => f !== 'profiles.json')).toEqual([]);
  });

  it('assigns a new id when input.id is missing', async () => {
    const store = createProfileStore(file, fakeCipher());
    const a = await store.save(input());
    const b = await store.save(input());
    expect(a.id).toBeTruthy();
    expect(b.id).not.toBe(a.id);
    expect(await store.list()).toHaveLength(2);
  });

  it('removes a profile and its last result', async () => {
    const store = createProfileStore(file, fakeCipher());
    const a = await store.save(input());
    await store.setLastResult(a.id, { status: 'cancelled', targetState: 'untouched' });
    await store.remove(a.id);
    expect(await store.list()).toEqual([]);
    expect(await store.lastResult(a.id)).toBeNull();
  });

  it('persists the last result per profile', async () => {
    const store = createProfileStore(file, fakeCipher());
    const a = await store.save(input());
    expect(await store.lastResult(a.id)).toBeNull();
    const outcome: SyncOutcome = { status: 'success', durationMs: 5, warnings: [], targetState: 'replaced' };
    await store.setLastResult(a.id, outcome);
    expect(await createProfileStore(file, fakeCipher()).lastResult(a.id)).toEqual(outcome);
  });

  it('get rejects for an unknown id', async () => {
    const store = createProfileStore(file, fakeCipher());
    await expect(store.get('nope')).rejects.toThrow(/not found/i);
  });

  it.each([
    ['empty name', (i: ProfileInput) => { i.name = '  '; }],
    ['empty source database', (i: ProfileInput) => { i.source.database = ''; }],
    ['empty target database', (i: ProfileInput) => { i.target.database = ''; }],
    ['blank source host', (i: ProfileInput) => { i.source.host = '  '; }],
    ['blank target host', (i: ProfileInput) => { i.target.host = ''; }],
    ['blank source user', (i: ProfileInput) => { i.source.user = ' '; }],
    ['blank target user', (i: ProfileInput) => { i.target.user = ''; }],
    ['port 0', (i: ProfileInput) => { i.source.port = 0; }],
    ['port 70000', (i: ProfileInput) => { i.target.port = 70000; }]
  ])('rejects invalid input: %s', async (_label, mutate) => {
    const store = createProfileStore(file, fakeCipher());
    const i = input();
    mutate(i);
    await expect(store.save(i)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });
});

describe('profile store resilience', () => {
  const brokenFor = (bad: string): Cipher => ({
    ...fakeCipher(),
    decrypt: (s) => {
      const plain = fakeCipher().decrypt(s);
      if (plain === bad) throw new Error('Decryption failed');
      return plain;
    }
  });

  it('lists every profile when one password cannot be decrypted, and flags that side', async () => {
    const store = createProfileStore(file, fakeCipher());
    const good = input({ name: 'Good' });
    good.source.password = 'fine';
    good.target.password = 'fine';
    const bad = input({ name: 'Bad' });
    bad.target.password = 'lost-key';
    const a = await store.save(good);
    const b = await store.save(bad);
    const reader = createProfileStore(file, brokenFor('lost-key'));
    const entries = await reader.listEntries();
    expect(entries.map((e) => e.profile.id)).toEqual([a.id, b.id]);
    expect(entries[0].unreadable).toEqual({ source: false, target: false });
    expect(entries[1].unreadable).toEqual({ source: false, target: true });
    expect(entries[1].profile.target.password).toBe('');
    expect(await reader.list()).toHaveLength(2);
  });

  it('get refuses a profile whose password cannot be decrypted, naming the sides', async () => {
    const store = createProfileStore(file, fakeCipher());
    const bad = input();
    bad.source.password = 'lost-key';
    const saved = await store.save(bad);
    const reader = createProfileStore(file, brokenFor('lost-key'));
    const err = await reader.get(saved.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasswordUnreadableError);
    expect((err as PasswordUnreadableError).sides).toEqual({ source: true, target: false });
    expect((err as Error).message).toMatch(/enter it again/i);
  });

  it('toView reports passwordUnreadable per side, false by default', async () => {
    const store = createProfileStore(file, fakeCipher());
    const saved = await store.save(input());
    const plain = toView(saved, { lastResult: null, hasBackup: false, hasUnfinishedSync: false });
    expect(plain.source.passwordUnreadable).toBe(false);
    expect(plain.target.passwordUnreadable).toBe(false);
    const flagged = toView(saved, {
      lastResult: null, hasBackup: false, hasUnfinishedSync: false, passwordUnreadable: { source: false, target: true }
    });
    expect(flagged.source.passwordUnreadable).toBe(false);
    expect(flagged.target.passwordUnreadable).toBe(true);
  });

  it('save keeps the unreadable ciphertext and the flag when only another field changes', async () => {
    const store = createProfileStore(file, fakeCipher());
    const bad = input();
    bad.target.password = 'lost-key';
    const saved = await store.save(bad);
    const before = JSON.parse(await fs.readFile(file, 'utf8')).profiles[0].target.password as string;
    const reader = createProfileStore(file, brokenFor('lost-key'));
    const i = input({ id: saved.id, name: 'Renamed' });
    delete i.target.password;
    delete i.source.password;
    const again = await reader.save(i);
    expect(again.name).toBe('Renamed');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).profiles[0].target.password).toBe(before);
    expect((await reader.listEntries())[0].unreadable).toEqual({ source: false, target: true });
  });

  it('a typed password replaces an unreadable one', async () => {
    const store = createProfileStore(file, fakeCipher());
    const bad = input();
    bad.target.password = 'lost-key';
    const saved = await store.save(bad);
    const reader = createProfileStore(file, brokenFor('lost-key'));
    const i = input({ id: saved.id });
    i.target.password = 'fresh';
    await reader.save(i);
    expect((await reader.listEntries())[0].unreadable).toEqual({ source: false, target: false });
    expect((await reader.get(saved.id)).target.password).toBe('fresh');
  });

  it('reuses the stored source password only while source host and port are unchanged', async () => {
    const store = createProfileStore(file, fakeCipher());
    const saved = await store.save(input());
    const keep = input({ id: saved.id, name: 'Same' });
    delete keep.source.password;
    delete keep.target.password;
    expect((await store.save(keep)).source.password).toBe('hunter2');
    for (const change of [(i: ProfileInput) => { i.source.host = 'evil.example.com'; }, (i: ProfileInput) => { i.source.port = 5999; }]) {
      const moved = input({ id: saved.id });
      change(moved);
      delete moved.source.password;
      const before = await fs.readFile(file, 'utf8');
      await expect(store.save(moved)).rejects.toThrow('Enter the password for the new host.');
      expect(await fs.readFile(file, 'utf8')).toBe(before);
    }
    const typed = input({ id: saved.id });
    typed.source.host = 'new.example.com';
    typed.source.password = '';
    expect((await store.save(typed)).source.password).toBe('');
    // the target side keeps its stored password even when its host changes
    const t = input({ id: saved.id });
    t.source.password = 'x';
    t.target.host = '127.0.0.1';
    delete t.target.password;
    expect((await store.save(t)).target.password).toBe('hunter2');
  });

  it.each([
    ['profile missing fields', '{"profiles":[{"id":"a"}]}'],
    ['number entry', '[1]'],
    ['number in profiles', '{"profiles":[1]}'],
    ['null in profiles', '{"profiles":[null]}'],
    ['non-string password', JSON.stringify({ profiles: [{ id: 'a', name: 'n', engine: 'postgres', backupEnabled: true,
      source: { host: 'h', port: 1, user: 'u', password: 5, database: 'd', ssl: false },
      target: { host: 'h', port: 1, user: 'u', password: '', database: 'd' } }] })],
  ])('treats %s as corrupt and never rewrites the file', async (_l, text) => {
    await fs.writeFile(file, text, 'utf8');
    const store = createProfileStore(file, fakeCipher());
    await expect(store.list()).rejects.toThrow(file);
    await expect(store.save(input())).rejects.toThrow(file);
    await expect(store.remove('a')).rejects.toThrow(file);
    await expect(store.setLastResult('a', { status: 'cancelled', targetState: 'untouched' })).rejects.toThrow(file);
    expect(await fs.readFile(file, 'utf8')).toBe(text);
  });

  it('names the file when profiles.json is corrupt, and does not overwrite it', async () => {
    await fs.writeFile(file, '{ not json', 'utf8');
    const store = createProfileStore(file, fakeCipher());
    await expect(store.list()).rejects.toThrow(file);
    await expect(store.save(input())).rejects.toThrow(file);
    await expect(store.remove('x')).rejects.toThrow(file);
    await expect(store.setLastResult('x', { status: 'cancelled', targetState: 'untouched' })).rejects.toThrow(file);
    expect(await fs.readFile(file, 'utf8')).toBe('{ not json');
    expect((await fs.readdir(dir)).sort()).toEqual(['profiles.json']);
  });

  it('treats a file with the wrong shape as corrupt', async () => {
    await fs.writeFile(file, '[1,2]', 'utf8');
    const store = createProfileStore(file, fakeCipher());
    await expect(store.list()).rejects.toThrow(file);
  });

  it('setLastResult skips a profile that was removed instead of writing an orphan', async () => {
    const store = createProfileStore(file, fakeCipher());
    const a = await store.save(input());
    await store.remove(a.id);
    const before = await fs.readFile(file, 'utf8');
    await store.setLastResult(a.id, { status: 'cancelled', targetState: 'untouched' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await store.lastResult(a.id)).toBeNull();
  });
});
