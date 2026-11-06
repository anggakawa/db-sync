import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

const yauzl = createRequire(import.meta.url)('yauzl');

export async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Resolves when the file's SHA-256 equals `expected`; rejects otherwise. */
export async function verifyHash(file, expected) {
  const actual = await sha256File(file);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
}

function openZip(zipPath) {
  return new Promise((res, rej) => {
    // decodeStrings:false so our own escape check sees the raw names instead of yauzl's.
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false }, (err, zip) => (err ? rej(err) : res(zip)));
  });
}

/**
 * Extracts a zip into `destDir`. `allow` is null (everything) or a list of entry names matched
 * case-insensitively. The first `strip` path components are dropped from the written path.
 * Any entry whose name would land outside `destDir` aborts the extraction, allowlisted or not.
 * Returns the written paths, relative to `destDir`, with forward slashes.
 */
export async function extractFiltered(zipPath, destDir, allow, strip = 0) {
  const wanted = allow ? new Set(allow.map((n) => n.toLowerCase())) : null;
  const root = resolve(destDir);
  const zip = await openZip(zipPath);
  const written = [];
  try {
    await new Promise((done, fail) => {
      zip.on('error', fail);
      zip.on('end', done);
      zip.on('entry', (entry) => {
        const name = Buffer.isBuffer(entry.fileName) ? entry.fileName.toString('utf8') : entry.fileName;
        const parts = name.split(/[\\/]/);
        if (isAbsolute(name) || /^[a-zA-Z]:/.test(name) || parts.includes('..')) {
          return fail(new Error(`Archive entry escapes the destination: ${name}`));
        }
        const isDir = name.endsWith('/');
        const keep = !isDir && (!wanted || wanted.has(name.toLowerCase()));
        const rel = parts.slice(strip).join('/');
        if (!keep || !rel) return zip.readEntry();
        const target = resolve(root, rel);
        if (!target.startsWith(root + sep)) {
          return fail(new Error(`Archive entry escapes the destination: ${name}`));
        }
        zip.openReadStream(entry, async (err, stream) => {
          if (err) return fail(err);
          try {
            await mkdir(dirname(target), { recursive: true });
            await pipeline(stream, createWriteStream(target));
            written.push(rel);
            zip.readEntry();
          } catch (e) {
            fail(e);
          }
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return written;
}
