import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { createDefinerFilter } from '../../src/main/engines/mysql/definer-filter';

async function run(chunks: Buffer[]): Promise<Buffer> {
  const out: Buffer[] = [];
  const filter = createDefinerFilter();
  filter.on('data', (c: Buffer) => out.push(c));
  await pipeline(Readable.from(chunks, { objectMode: false }), filter);
  return Buffer.concat(out);
}
const filterText = async (text: string, chunkSize = Infinity) => {
  const buf = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += Math.min(chunkSize, buf.length)) chunks.push(buf.subarray(i, i + chunkSize));
  return (await run(chunks)).toString('utf8');
};

describe('definer filter', () => {
  it.each([
    ['/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */', '/*!50013 SQL SECURITY DEFINER */'],
    ['/*!50003 CREATE*/ /*!50017 DEFINER=`a``b`@`localhost`*/ /*!50003 TRIGGER t', '/*!50003 CREATE*/ /*!50003 TRIGGER t'],
    ['/*!50106 CREATE*/ /*!50117 DEFINER=`root`@`%`*/ /*!50106 EVENT e', '/*!50106 CREATE*/ /*!50106 EVENT e'],
    ['CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()', 'CREATE PROCEDURE `p`()'],
    ['CREATE DEFINER=`root`@`%` FUNCTION `f`()', 'CREATE FUNCTION `f`()'],
  ])('removes the clause from %s', async (input, expected) => {
    expect(await filterText(`${input}\n`)).toBe(`${expected}\n`);
  });

  it('removes only the first match of each pattern on a line', async () => {
    const line = 'CREATE DEFINER=`a`@`%` PROCEDURE x() BEGIN SELECT \'CREATE DEFINER=`b`@`%` \'; END';
    expect(await filterText(`${line}\n`)).toBe('CREATE PROCEDURE x() BEGIN SELECT \'CREATE DEFINER=`b`@`%` \'; END\n');
  });

  it('leaves INSERT lines byte-identical', async () => {
    const insert = "INSERT INTO `t` VALUES ('CREATE DEFINER=`root`@`%` x', 0xFF00);\n";
    expect(await filterText(insert)).toBe(insert);
    expect(await filterText(`CREATE DEFINER=\`r\`@\`%\` FUNCTION f()\n${insert}`)).toBe(`CREATE FUNCTION f()\n${insert}`);
  });

  it('leaves the row lines of a multi-line INSERT untouched, as MariaDB writes them', async () => {
    const rows = [
      'INSERT INTO `t` VALUES',
      "(1,'CREATE DEFINER=`root`@`%` x'),",
      "(2,'/*!50013 DEFINER=`a`@`b` SQL SECURITY DEFINER */'),",
      "(3,'CREATE DEFINER=`root`@`%` y');",
    ];
    for (const eol of ['\n', '\r\n']) {
      const insert = rows.join(eol) + eol;
      const input = `${insert}CREATE DEFINER=\`r\`@\`%\` FUNCTION f()${eol}-- after${eol}`;
      const want = `${insert}CREATE FUNCTION f()${eol}-- after${eol}`;
      expect(await filterText(input)).toBe(want);
      expect(await filterText(input, 1)).toBe(want);
      expect(await filterText(input, 7)).toBe(want);
    }
  });

  it('filters again once the INSERT statement has ended', async () => {
    const f = 'CREATE DEFINER=`r`@`%` FUNCTION ';
    const input = `INSERT INTO t VALUES\n(1,'x');\n${f}f()\nINSERT INTO t VALUES (2,'y');\n${f}g()\n`;
    expect(await filterText(input)).toBe("INSERT INTO t VALUES\n(1,'x');\nCREATE FUNCTION f()\nINSERT INTO t VALUES (2,'y');\nCREATE FUNCTION g()\n");
  });

  it('handles a clause split across chunks', async () => {
    const text = '/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */\nCREATE DEFINER=`root`@`%` FUNCTION `f`()\n';
    expect(await filterText(text, 1)).toBe('/*!50013 SQL SECURITY DEFINER */\nCREATE FUNCTION `f`()\n');
  });

  it('passes through a final line with no newline', async () => {
    expect(await filterText('CREATE DEFINER=`root`@`%` FUNCTION `f`()')).toBe('CREATE FUNCTION `f`()');
    expect(await filterText('-- tail')).toBe('-- tail');
    expect(await filterText("INSERT INTO t VALUES (1)", 1)).toBe('INSERT INTO t VALUES (1)');
  });

  it('keeps a Windows line ending after a filtered line', async () => {
    expect(await filterText('CREATE DEFINER=`r`@`%` FUNCTION f()\r\n-- x\r\n')).toBe('CREATE FUNCTION f()\r\n-- x\r\n');
  });

  it('keeps non-UTF-8 bytes on INSERT lines', async () => {
    const head = Buffer.from("INSERT INTO `t` VALUES ('", 'utf8');
    const odd = Buffer.from([0xff, 0xfe, 0x80, 0xc3, 0x28]);
    const input = Buffer.concat([head, odd, Buffer.from("');\n")]);
    expect((await run([input])).equals(input)).toBe(true);
    const bytewise = Array.from(input, (b) => Buffer.from([b]));
    expect((await run(bytewise)).equals(input)).toBe(true);
  });

  it('keeps non-UTF-8 bytes on other lines too, including the ones it edits', async () => {
    const input = Buffer.concat([Buffer.from('CREATE DEFINER=`r`@`%` FUNCTION f() -- '), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]);
    const want = Buffer.concat([Buffer.from('CREATE FUNCTION f() -- '), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]);
    expect((await run([input])).equals(want)).toBe(true);
  });

  it('handles a 50 MB INSERT line without quadratic slowdown', async () => {
    const head = Buffer.from('INSERT INTO `t` VALUES (');
    const piece = Buffer.alloc(64 * 1024, 0x61);
    const chunks = [head];
    for (let i = 0; i < 800; i += 1) chunks.push(piece); // about 52 MB
    chunks.push(Buffer.from(');\nCREATE DEFINER=`r`@`%` FUNCTION f()\n'));
    const started = Date.now();
    const out = await run(chunks);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.length).toBe(head.length + piece.length * 800 + ');\nCREATE FUNCTION f()\n'.length);
    expect(out.subarray(out.length - 20).toString()).toBe('CREATE FUNCTION f()\n');
  });

  it('handles a very long line that is not an INSERT without keeping all of it', async () => {
    const piece = Buffer.alloc(64 * 1024, 0x62);
    const chunks = [Buffer.from('-- ')];
    for (let i = 0; i < 400; i += 1) chunks.push(piece);
    chunks.push(Buffer.from('\nCREATE DEFINER=`r`@`%` FUNCTION f()\n'));
    const started = Date.now();
    const out = await run(chunks);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.subarray(out.length - 20).toString()).toBe('CREATE FUNCTION f()\n');
    expect(out.length).toBe(3 + piece.length * 400 + 1 + 20);
  });
});
