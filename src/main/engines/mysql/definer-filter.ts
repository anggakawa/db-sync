import { Transform, type TransformCallback } from 'node:stream';

/** A quoted `user`@`host` pair, where a doubled backquote stands for a literal one. */
const USER = '`(?:[^`]|``)*`@`(?:[^`]|``)*`';
const CONDITIONAL_CLAUSE = new RegExp(String.raw`/\*!\d+ DEFINER=${USER}\s*\*/ ?`);
const BEFORE_SQL_SECURITY = new RegExp(String.raw`(/\*!\d+) DEFINER=${USER} (SQL SECURITY)`);
const CREATE_CLAUSE = new RegExp(String.raw`\bCREATE DEFINER=${USER} `);

const INSERT_PREFIX = Buffer.from('INSERT INTO');
const DEFINER_TEXT = Buffer.from('DEFINER=');
const NEWLINE = Buffer.from('\n');
/** A line that is not an INSERT and grows past this is passed on unchanged; a DEFINER clause is always near its start. */
const MAX_BUFFERED_LINE = 1024 * 1024;

/**
 * Bytes of one line other than an INSERT. Decoded as latin1 so that every byte survives the round trip, including
 * ones that are not valid UTF-8; the patterns only match ASCII.
 */
function filterLine(line: Buffer): Buffer {
  if (!line.includes(DEFINER_TEXT)) return line;
  const text = line.toString('latin1')
    .replace(CONDITIONAL_CLAUSE, '')
    .replace(BEFORE_SQL_SECURITY, '$1 $2')
    .replace(CREATE_CLAUSE, 'CREATE ');
  return Buffer.from(text, 'latin1');
}

type Mode =
  | 'start' // fewer than 11 bytes of the line seen
  | 'insert' // an INSERT line: bytes go straight through, never decoded
  | 'other' // collected until the line ends, then filtered
  | 'raw'; // an over-long line that is not an INSERT: the rest goes straight through

/**
 * Removes DEFINER clauses from mysqldump output so a restore does not need the source's users.
 * Works on bytes and keeps at most one short line in memory, so a huge INSERT line costs nothing extra.
 */
export function createDefinerFilter(): Transform {
  let mode: Mode = 'start';
  let pending: Buffer[] = [];
  let pendingLength = 0;
  // MariaDB writes the rows of one INSERT on separate lines. Every line of the statement is data, up to the one ending in ";".
  let insideInsert = false;
  let lastByte = -1; // the last byte of the current INSERT line, not counting a carriage return

  const noteTail = (segment: Buffer): void => {
    for (let i = segment.length - 1; i >= 0; i -= 1) {
      if (segment[i] === 0x0d) continue;
      lastByte = segment[i];
      return;
    }
  };

  const endLine = (out: Buffer[], newline: boolean): void => {
    if (newline) out.push(NEWLINE);
    insideInsert = mode === 'insert' && lastByte !== 0x3b;
    lastByte = -1;
    mode = 'start';
  };

  const take = (segment: Buffer, newline: boolean, out: Buffer[]): void => {
    if (mode === 'start' && insideInsert && pendingLength === 0) mode = 'insert';
    if (mode === 'insert' || mode === 'raw') {
      if (mode === 'insert') noteTail(segment);
      out.push(segment);
      if (newline) endLine(out, true);
      return;
    }
    pending.push(segment);
    pendingLength += segment.length;
    if (mode === 'start' && (pendingLength >= INSERT_PREFIX.length || newline)) {
      const head = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      pending = [head];
      if (pendingLength >= INSERT_PREFIX.length && head.subarray(0, INSERT_PREFIX.length).equals(INSERT_PREFIX)) {
        out.push(head);
        noteTail(head);
        pending = [];
        pendingLength = 0;
        mode = 'insert';
        if (newline) endLine(out, true);
        return;
      }
      mode = 'other';
    }
    if (newline) {
      out.push(filterLine(pending.length === 1 ? pending[0] : Buffer.concat(pending)));
      pending = [];
      pendingLength = 0;
      endLine(out, true);
    } else if (pendingLength > MAX_BUFFERED_LINE) {
      out.push(...pending);
      pending = [];
      pendingLength = 0;
      mode = 'raw';
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      const out: Buffer[] = [];
      let pos = 0;
      while (pos < chunk.length) {
        const nl = chunk.indexOf(0x0a, pos);
        if (nl < 0) {
          take(chunk.subarray(pos), false, out);
          break;
        }
        take(chunk.subarray(pos, nl), true, out);
        pos = nl + 1;
      }
      callback(null, out.length === 1 ? out[0] : Buffer.concat(out));
    },
    flush(callback: TransformCallback) {
      // A last line without a newline.
      callback(null, pending.length > 0 ? filterLine(Buffer.concat(pending)) : undefined);
    },
  });
}
