import { promises as dns } from 'node:dns';

export type GuardResult = { allowed: true } | { allowed: false; reason: string };
export type Lookup = (host: string) => Promise<string[]>;

const defaultLookup: Lookup = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address);

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

/** Exact match only: no trimming, no case folding. */
export async function checkTargetHost(host: string, lookup: Lookup = defaultLookup): Promise<GuardResult> {
  if (host === '127.0.0.1' || host === '::1') return { allowed: true };
  if (host !== 'localhost') {
    return { allowed: false, reason: 'The target host must be exactly localhost, 127.0.0.1 or ::1.' };
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return { allowed: false, reason: 'localhost could not be resolved.' };
  }
  if (addresses.length === 0 || !addresses.every(isLoopbackAddress)) {
    return { allowed: false, reason: 'localhost does not resolve only to loopback addresses.' };
  }
  return { allowed: true };
}
