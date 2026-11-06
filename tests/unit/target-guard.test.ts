import { describe, expect, it } from 'vitest';
import { checkTargetHost } from '../../src/main/safety/target-guard';

describe('checkTargetHost', () => {
  it.each(['127.0.0.1', '::1'])('allows %s', async (h) => expect((await checkTargetHost(h)).allowed).toBe(true));
  it('allows localhost when it resolves only to loopback', async () =>
    expect((await checkTargetHost('localhost', async () => ['127.0.0.1', '::1'])).allowed).toBe(true));
  it('rejects localhost that resolves elsewhere', async () =>
    expect((await checkTargetHost('localhost', async () => ['127.0.0.1', '10.0.0.5'])).allowed).toBe(false));
  it('rejects localhost when the lookup fails', async () =>
    expect((await checkTargetHost('localhost', async () => { throw new Error('ENOTFOUND'); })).allowed).toBe(false));
  it('rejects localhost that resolves to nothing', async () =>
    expect((await checkTargetHost('localhost', async () => [])).allowed).toBe(false));
  it.each(['dev-db', '10.0.0.5', '127.0.0.2', 'localhost.evil.com', 'LOCALHOST ', '', '0.0.0.0', 'host.docker.internal'])(
    'rejects %j', async (h) => expect((await checkTargetHost(h, async () => ['127.0.0.1'])).allowed).toBe(false));
  it('gives a reason when rejecting', async () => {
    const r = await checkTargetHost('dev-db');
    expect(r.allowed === false && r.reason.length > 0).toBe(true);
  });
});
