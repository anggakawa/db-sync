export interface DatabaseIdentity {
  host: string;
  port: number;
  database: string;
  serverIdentity: string | null;
}

function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ? 'loopback' : h;
}

export function isSameDatabase(a: DatabaseIdentity, b: DatabaseIdentity): boolean {
  if (a.database !== b.database) return false;
  if (a.serverIdentity !== null && a.serverIdentity === b.serverIdentity) return true;
  return normalizeHost(a.host) === normalizeHost(b.host) && a.port === b.port;
}
