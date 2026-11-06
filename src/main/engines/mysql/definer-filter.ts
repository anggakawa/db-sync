import { Transform, type TransformCallback } from 'node:stream';

/** A quoted `user`@`host` pair, where a doubled backquote stands for a literal one. */
const USER = '`(?:[^`]|``)*`@`(?:[^`]|``)*`';
// Each pattern is anchored to the start of an object header line, so text inside a string, a comment or a routine body is never touched.
const ROUTINE = new RegExp(String.raw`^CREATE DEFINER=${USER} `);
const TRIGGER_OR_EVENT = new RegExp(String.raw`^(/\*!\d+ CREATE\*/ )/\*!\d+ DEFINER=${USER}\s*\*/ ?`);
const VIEW = new RegExp(String.raw`^(/\*!\d+) DEFINER=${USER} (SQL SECURITY)`);
/** MySQL writes session settings like this between DELIMITER ;; and an event. */
const SESSION_SETTING = /^\/\*!50003 SET .*\*\/ ;;\r?$/;

const INSERT_PREFIX = Buffer.from('INSERT INTO');
const DEFINER_TEXT = Buffer.from('DEFINER=');
const NEWLINE = Buffer.from('\n');
/** A line that is not an INSERT and grows past this is passed on unchanged; a DEFINER clause is always near its start. */
const MAX_BUFFERED_LINE = 1024 * 1024;

/** Where the line being read stands in the dump's structure. */
type Header = 'none' | 'afterDelimiter' | 'afterViewStart';

/**
 * One line other than an INSERT, with what the dump structure says about it. Only the line right after DELIMITER ;;
 * (routine, trigger, event) or right after a view's CREATE ALGORITHM line may carry a definer. Decoded as latin1 so
 * every byte survives the round trip, including ones that are not valid UTF-8; the patterns only match ASCII.
 */
function processLine(line: Buffer, header: Header): { out: Buffer; next: Header } {
  const text = line.toString('latin1');
  let next: Header = 'none';
  let edited = text;
  if (header === 'afterDelimiter') {
    if (SESSION_SETTING.test(text)) next = 'afterDelimiter';
    else if (line.includes(DEFINER_TEXT)) edited = text.replace(ROUTINE, 'CREATE ').replace(TRIGGER_OR_EVENT, '$1');
  } else if (header === 'afterViewStart' && line.includes(DEFINER_TEXT)) {
    edited = text.replace(VIEW, '$1 $2');
  }
  if (next === 'none') {
    if (text.replace(/\r$/, '') === 'DELIMITER ;;') next = 'afterDelimiter';
    else if (text.startsWith('/*!50001 CREATE ALGORITHM')) next = 'afterViewStart';
  }
  return { out: edited === text ? line : Buffer.from(edited, 'latin1'), next };
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
  let header: Header = 'none';
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
    if (mode === 'insert' || mode === 'raw') header = 'none';
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
      const done = processLine(pending.length === 1 ? pending[0] : Buffer.concat(pending), header);
      out.push(done.out);
      header = done.next;
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
      callback(null, pending.length > 0 ? processLine(Buffer.concat(pending), header).out : undefined);
    },
  });
}
