// Downloads the vendor client-tool archives pinned in tools/manifest.json, verifies SHA-256,
// and extracts the allowlisted files into resources/tools/<flavor>/.
// With --with-servers, each full archive is also extracted to .cache/servers/<name>/.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extractFiltered, verifyHash } from './lib/archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const withServers = process.argv.includes('--with-servers');
const manifest = JSON.parse(await readFile(join(root, 'tools', 'manifest.json'), 'utf8'));
const archiveDir = join(root, '.cache', 'archives');
const STALL_MS = 5 * 60 * 1000;

async function exists(p) {
  return stat(p).then(() => true, () => false);
}

async function download(url, file) {
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.part`;
  const ctrl = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error(`Download stalled for 5 minutes: ${url}`)), STALL_MS);
  };
  arm();
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
    const body = Readable.fromWeb(res.body);
    body.on('data', arm);
    await pipeline(body, createWriteStream(partial), { signal: ctrl.signal });
    await rename(partial, file);
  } finally {
    clearTimeout(timer);
    await rm(partial, { force: true });
  }
}

async function ensureArchive(entry) {
  const file = join(archiveDir, basename(new URL(entry.url).pathname));
  if (await exists(file)) {
    try {
      await verifyHash(file, entry.sha256);
      return file;
    } catch {
      console.log(`${entry.name}: cached archive does not match the pinned hash, downloading again`);
      await rm(file, { force: true });
    }
  }
  console.log(`${entry.name}: downloading ${entry.url}`);
  await download(entry.url, file);
  // Untrusted until this passes; a mismatch deletes the file and aborts.
  try {
    await verifyHash(file, entry.sha256);
  } catch (e) {
    await rm(file, { force: true });
    throw e;
  }
  return file;
}

/** Re-extracts only when the target was not already produced from this archive hash and allowlist. */
async function extractOnce(archive, entry, dest, allow, strip) {
  const marker = join(dest, '.extracted');
  const stamp = createHash('sha256').update(JSON.stringify([entry.sha256, allow])).digest('hex');
  if ((await readFile(marker, 'utf8').catch(() => '')).trim() === stamp) return false;
  await rm(dest, { recursive: true, force: true });
  const written = await extractFiltered(archive, dest, allow, strip);
  if (allow) {
    const missing = allow.filter((n) => !written.includes(n.split('/').slice(strip).join('/')));
    if (missing.length) throw new Error(`${entry.name}: allowlisted files missing from archive: ${missing.join(', ')}`);
  }
  await mkdir(dest, { recursive: true });
  await writeFile(marker, `${stamp}\n`);
  return true;
}

for (const entry of manifest) {
  if (!entry.bundle && !withServers) continue;
  const archive = await ensureArchive(entry);
  if (entry.bundle) {
    const dest = join(root, 'resources', 'tools', entry.flavor);
    const did = await extractOnce(archive, entry, dest, entry.files, 1);
    console.log(`${entry.name}: ${did ? 'extracted' : 'up to date'} -> resources/tools/${entry.flavor}`);
  }
  if (withServers) {
    const dest = join(root, '.cache', 'servers', entry.name);
    const did = await extractOnce(archive, entry, dest, null, 1);
    console.log(`${entry.name}: ${did ? 'extracted' : 'up to date'} -> .cache/servers/${entry.name}`);
  }
}
