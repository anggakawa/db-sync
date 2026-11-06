import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { parseProfileInput, registerIpc } from '../../src/main/ipc';
import type { SyncService } from '../../src/main/sync/sync-service';
import { CHANNELS } from '../../src/shared/api';
import type { ProfileInput } from '../../src/shared/types';

const valid = () => ({
  name: 'Orders', engine: 'postgres', backupEnabled: true,
  source: { host: 'dev', port: 5432, user: 'ro', password: 'x', database: 'orders', ssl: true },
  target: { host: 'localhost', port: 5433, user: 'me', database: 'orders' },
});

function setup(trusted = true) {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>();
  const ipc = {
    handle: (c: string, h: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => { handlers.set(c, h); },
    removeHandler: (c: string) => { handlers.delete(c); },
  } as unknown as IpcMain;
  const service = {
    listProfiles: vi.fn(async () => []), saveProfile: vi.fn(async (i: unknown) => i), deleteProfile: vi.fn(async () => undefined),
    testConnection: vi.fn(async () => ({ ok: true })), startSync: vi.fn(async () => ({})), restoreBackup: vi.fn(async () => ({})),
    recover: vi.fn(async () => ({})), cancel: vi.fn(async () => undefined), answerWarnings: vi.fn(async () => undefined),
  };
  const remove = registerIpc(ipc, service as unknown as SyncService, () => trusted);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args);
  return { handlers, service, call, remove };
}

describe('ipc validation', () => {
  it('registers exactly the fixed request channels', () => {
    const { handlers } = setup();
    const expected = Object.values(CHANNELS).filter((c) => c !== CHANNELS.syncEvent && c !== CHANNELS.warnings).sort();
    expect([...handlers.keys()].sort()).toEqual(expected);
  });

  it('passes a valid profile through, dropping an absent password', async () => {
    const { call, service } = setup();
    await call(CHANNELS.saveProfile, valid());
    expect(service.saveProfile).toHaveBeenCalledWith(valid());
    expect(Object.keys((service.saveProfile.mock.calls[0][0] as ProfileInput).target)).not.toContain('password');
  });

  it.each([
    ['extra top-level field', (p: Record<string, unknown>) => { p['extra'] = 1; }],
    ['hasPassword leaked back from a view', (p: Record<string, any>) => { p['source'].hasPassword = true; }],
    ['target ssl', (p: Record<string, any>) => { p['target'].ssl = true; }],
    ['unknown engine', (p: Record<string, unknown>) => { p['engine'] = 'oracle'; }],
    ['string port', (p: Record<string, any>) => { p['source'].port = '5432'; }],
    ['fractional port', (p: Record<string, any>) => { p['target'].port = 5432.5; }],
    ['missing name', (p: Record<string, unknown>) => { delete p['name']; }],
    ['non-boolean backup', (p: Record<string, unknown>) => { p['backupEnabled'] = 'yes'; }],
    ['non-string password', (p: Record<string, any>) => { p['source'].password = 5; }],
    ['path in id', (p: Record<string, unknown>) => { p['id'] = '../x'; }],
    ['null source', (p: Record<string, unknown>) => { p['source'] = null; }],
    ['array target', (p: Record<string, unknown>) => { p['target'] = []; }],
  ])('rejects a profile with %s', (_l, mutate) => {
    const p = valid() as Record<string, unknown>;
    mutate(p);
    expect(() => parseProfileInput(p)).toThrow(/invalid request/i);
  });

  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'x', 5, [valid()]]) expect(() => parseProfileInput(v)).toThrow(/invalid request/i);
  });

  it('rejects a wrong number of arguments and bad ids, before calling the service', async () => {
    const { call, service } = setup();
    await expect(call(CHANNELS.listProfiles, 'extra')).rejects.toThrow(/invalid request/i);
    await expect(call(CHANNELS.startSync)).rejects.toThrow(/invalid request/i);
    await expect(call(CHANNELS.startSync, 'a', 'b')).rejects.toThrow(/invalid request/i);
    await expect(call(CHANNELS.startSync, '../etc')).rejects.toThrow(/invalid request/i);
    await expect(call(CHANNELS.deleteProfile, 5)).rejects.toThrow(/invalid request/i);
    await expect(call(CHANNELS.restoreBackup, { id: 'a' })).rejects.toThrow(/invalid request/i);
    await expect(call(CHANNELS.answerWarnings, 'yes')).rejects.toThrow(/invalid request/i);
    await expect(call(CHANNELS.testConnection, valid(), 'both')).rejects.toThrow(/invalid request/i);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('accepts well-formed calls', async () => {
    const { call, service } = setup();
    await call(CHANNELS.startSync, 'abc-123');
    await call(CHANNELS.answerWarnings, true);
    await call(CHANNELS.testConnection, valid(), 'target');
    await call(CHANNELS.cancel);
    expect(service.startSync).toHaveBeenCalledWith('abc-123');
    expect(service.answerWarnings).toHaveBeenCalledWith(true);
    expect(service.testConnection).toHaveBeenCalledWith(valid(), 'target');
    expect(service.cancel).toHaveBeenCalled();
  });

  it('refuses callers that are not the app window', async () => {
    const { call, service } = setup(false);
    await expect(call(CHANNELS.startSync, 'abc')).rejects.toThrow(/not allowed/i);
    expect(service.startSync).not.toHaveBeenCalled();
  });

  it('removes its handlers', () => {
    const { handlers, remove } = setup();
    remove();
    expect(handlers.size).toBe(0);
  });
});
