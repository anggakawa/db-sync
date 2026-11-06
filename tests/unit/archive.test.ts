import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { extractFiltered, verifyHash } from '../../scripts/lib/archive.mjs';

/** Builds a minimal stored (uncompressed) zip so tests can include hostile entry names. */
function buildZip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

describe('archive helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbsync-archive-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('verifyHash rejects a file whose SHA-256 differs', async () => {
    const file = join(dir, 'a.bin');
    writeFileSync(file, 'hello');
    const good = createHash('sha256').update('hello').digest('hex');
    await expect(verifyHash(file, good)).resolves.toBeUndefined();
    await expect(verifyHash(file, good.replace(/^./, (c: string) => (c === '0' ? '1' : '0')))).rejects.toThrow(/SHA-256/);
  });

  it('extractFiltered refuses an entry that escapes the destination', async () => {
    const zip = join(dir, 'evil.zip');
    writeFileSync(zip, buildZip({ 'root/bin/ok.exe': 'ok', '../evil.exe': 'x' }));
    const dest = join(dir, 'out', 'dest');
    await expect(extractFiltered(zip, dest, null, 1)).rejects.toThrow(/escapes/);
    expect(existsSync(join(dir, 'out', 'evil.exe'))).toBe(false);
  });

  it('extractFiltered extracts only entries matching the allowlist', async () => {
    const zip = join(dir, 'ok.zip');
    writeFileSync(zip, buildZip({ 'root/bin/tool.exe': 'T', 'root/bin/lib.dll': 'L', 'root/bin/other.exe': 'O', 'root/doc/readme.txt': 'R' }));
    const dest = join(dir, 'dest');
    const written = await extractFiltered(zip, dest, ['root/bin/tool.exe', 'ROOT/bin/lib.dll'], 1);
    expect(written.sort()).toEqual(['bin/lib.dll', 'bin/tool.exe']);
    expect(readFileSync(join(dest, 'bin', 'tool.exe'), 'utf8')).toBe('T');
    expect(existsSync(join(dest, 'bin', 'other.exe'))).toBe(false);
    expect(existsSync(join(dest, 'doc'))).toBe(false);
  });
});
