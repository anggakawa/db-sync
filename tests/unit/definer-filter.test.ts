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

const D = 'DELIMITER ;;\n'; // what mysqldump writes before a routine, trigger or event
const V = '/*!50001 CREATE ALGORITHM=UNDEFINED */\n'; // and before a view's DEFINER line
const FN = 'CREATE DEFINER=`r`@`%` FUNCTION f()';
const FN_CLEAN = 'CREATE FUNCTION f()';

describe('definer filter: object headers', () => {
  it.each([
    [V, '/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */', '/*!50013 SQL SECURITY DEFINER */'],
    [D, '/*!50003 CREATE*/ /*!50017 DEFINER=`a``b`@`localhost`*/ /*!50003 TRIGGER t', '/*!50003 CREATE*/ /*!50003 TRIGGER t'],
    [D, '/*!50106 CREATE*/ /*!50117 DEFINER=`root`@`%`*/ /*!50106 EVENT e', '/*!50106 CREATE*/ /*!50106 EVENT e'],
    [D, 'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()', 'CREATE PROCEDURE `p`()'],
    [D, 'CREATE DEFINER=`root`@`%` FUNCTION `f`()', 'CREATE FUNCTION `f`()'],
    // MySQL writes its session settings between DELIMITER ;; and an event.
    [`${D}/*!50003 SET sql_mode = 'x' */ ;;\n/*!50003 SET time_zone = 'SYSTEM' */ ;;\n`, '/*!50106 CREATE*/ /*!50117 DEFINER=`r`@`%`*/ /*!50106 EVENT e', '/*!50106 CREATE*/ /*!50106 EVENT e'],
  ])('removes the clause after %j: %s', async (context, input, expected) => {
    expect(await filterText(`${context}${input}\n`)).toBe(`${context}${expected}\n`);
    expect(await filterText(`${context}${input}\n`, 1)).toBe(`${context}${expected}\n`);
  });

  it.each([
    ['a column default', "  `c` varchar(100) DEFAULT 'CREATE DEFINER=`a`@`b` x',"],
    ['a table comment', ") ENGINE=InnoDB COMMENT='/*!1 DEFINER=`a`@`b`*/ note';"],
    ['a routine body line', "  SET @s = 'CREATE DEFINER=`root`@`%` VIEW v AS SELECT 1';"],
    ['a view-style line under no view header', '/*!50013 DEFINER=`a`@`b` SQL SECURITY DEFINER */'],
    ['a CREATE line that does not follow DELIMITER', 'CREATE DEFINER=`a`@`b` PROCEDURE p()'],
  ])('leaves %s unchanged', async (_name, line) => {
    const text = `-- before\n${line}\nDELIMITER ;\n-- body\n${line}\n`;
    expect(await filterText(text)).toBe(text);
    expect(await filterText(text, 3)).toBe(text);
  });

  it('leaves a header-looking line in a routine body unchanged', async () => {
    const text = `${D}CREATE PROCEDURE p()\nBEGIN\n${FN}\nEND\n`;
    expect(await filterText(text)).toBe(text);
  });

  it('edits only the first match in the header line', async () => {
    const line = "CREATE DEFINER=`a`@`%` PROCEDURE x() BEGIN SELECT 'CREATE DEFINER=`b`@`%` '; END";
    expect(await filterText(`${D}${line}\n`)).toBe(`${D}CREATE PROCEDURE x() BEGIN SELECT 'CREATE DEFINER=\`b\`@\`%\` '; END\n`);
  });

  it('handles a clause split across chunks', async () => {
    const text = `${V}/*!50013 DEFINER=\`root\`@\`%\` SQL SECURITY DEFINER */\n${D}CREATE DEFINER=\`root\`@\`%\` FUNCTION \`f\`()\n`;
    expect(await filterText(text, 1)).toBe(`${V}/*!50013 SQL SECURITY DEFINER */\n${D}CREATE FUNCTION \`f\`()\n`);
  });

  it('passes through a final line with no newline', async () => {
    expect(await filterText(`${D}CREATE DEFINER=\`root\`@\`%\` FUNCTION \`f\`()`)).toBe(`${D}CREATE FUNCTION \`f\`()`);
    expect(await filterText('-- tail')).toBe('-- tail');
    expect(await filterText('INSERT INTO t VALUES (1)', 1)).toBe('INSERT INTO t VALUES (1)');
  });

  it('keeps a Windows line ending after a filtered line', async () => {
    expect(await filterText(`DELIMITER ;;\r\n${FN}\r\n-- x\r\n`)).toBe(`DELIMITER ;;\r\n${FN_CLEAN}\r\n-- x\r\n`);
  });

  it('keeps non-UTF-8 bytes on the lines it edits and on others', async () => {
    const odd = Buffer.from([0xff, 0xfe]);
    const input = Buffer.concat([Buffer.from(`${D}${FN} -- `), odd, Buffer.from('\n')]);
    const want = Buffer.concat([Buffer.from(`${D}${FN_CLEAN} -- `), odd, Buffer.from('\n')]);
    expect((await run([input])).equals(want)).toBe(true);
  });
});

describe('definer filter: INSERT statements', () => {
  it('leaves INSERT lines byte-identical', async () => {
    const insert = "INSERT INTO `t` VALUES ('CREATE DEFINER=`root`@`%` x', 0xFF00);\n";
    expect(await filterText(insert)).toBe(insert);
    expect(await filterText(`${D}${FN}\n${insert}`)).toBe(`${D}${FN_CLEAN}\n${insert}`);
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
      const input = `${insert}DELIMITER ;;${eol}${FN}${eol}-- after${eol}`;
      const want = `${insert}DELIMITER ;;${eol}${FN_CLEAN}${eol}-- after${eol}`;
      expect(await filterText(input)).toBe(want);
      expect(await filterText(input, 1)).toBe(want);
      expect(await filterText(input, 7)).toBe(want);
    }
  });

  it('filters again once the INSERT statement has ended', async () => {
    const input = `INSERT INTO t VALUES\n(1,'x');\n${D}${FN}\nINSERT INTO t VALUES (2,'y');\n${D}${FN}\n`;
    expect(await filterText(input)).toBe(`INSERT INTO t VALUES\n(1,'x');\n${D}${FN_CLEAN}\nINSERT INTO t VALUES (2,'y');\n${D}${FN_CLEAN}\n`);
  });

  it('keeps non-UTF-8 bytes on INSERT lines', async () => {
    const head = Buffer.from("INSERT INTO `t` VALUES ('", 'utf8');
    const odd = Buffer.from([0xff, 0xfe, 0x80, 0xc3, 0x28]);
    const input = Buffer.concat([head, odd, Buffer.from("');\n")]);
    expect((await run([input])).equals(input)).toBe(true);
    const bytewise = Array.from(input, (b) => Buffer.from([b]));
    expect((await run(bytewise)).equals(input)).toBe(true);
  });

  it('handles a 50 MB INSERT line without quadratic slowdown', async () => {
    const head = Buffer.from('INSERT INTO `t` VALUES (');
    const piece = Buffer.alloc(64 * 1024, 0x61);
    const tail = `);\n${D}${FN}\n`;
    const chunks = [head];
    for (let i = 0; i < 800; i += 1) chunks.push(piece); // about 52 MB
    chunks.push(Buffer.from(tail));
    const started = Date.now();
    const out = await run(chunks);
    expect(Date.now() - started).toBeLessThan(10_000);
    const cleanTail = `);\n${D}${FN_CLEAN}\n`;
    expect(out.length).toBe(head.length + piece.length * 800 + cleanTail.length);
    expect(out.subarray(out.length - cleanTail.length).toString()).toBe(cleanTail);
  });

  it('handles a very long line that is not an INSERT without keeping all of it', async () => {
    const piece = Buffer.alloc(64 * 1024, 0x62);
    const chunks = [Buffer.from('-- ')];
    for (let i = 0; i < 400; i += 1) chunks.push(piece);
    chunks.push(Buffer.from(`\n${D}${FN}\n`));
    const started = Date.now();
    const out = await run(chunks);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.subarray(out.length - (D.length + FN_CLEAN.length + 1)).toString()).toBe(`${D}${FN_CLEAN}\n`);
    expect(out.length).toBe(3 + piece.length * 400 + 1 + D.length + FN_CLEAN.length + 1);
  });
});
