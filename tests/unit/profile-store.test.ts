import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProfileStore, toView, type Cipher } from '../../src/main/profiles/profile-store';
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
