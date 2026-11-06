// Test double for a dump tool. Usage: node fake-tool.mjs <mode> [...args]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);

if (mode === 'echo') {
  process.stdout.write(JSON.stringify({ args: rest, env: process.env }));
} else if (mode === 'cwd') {
  process.stdout.write(process.cwd());
} else if (mode === 'stderr') {
  // rest: text, exit code
  process.stderr.write(`${rest[0]}\n`);
  process.exit(Number(rest[1] ?? 0));
} else if (mode === 'bigerr') {
  // rest: secret, exit code. 100 KB of noise, then a line containing the secret.
  const line = 'x'.repeat(99) + '\n';
  for (let i = 0; i < 1000; i++) process.stderr.write(line);
  process.stderr.write(`password is ${rest[0]}\n`);
  process.exit(Number(rest[1] ?? 1));
} else if (mode === 'sleep') {
  // rest: file to receive the grandchild pid
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(rest[0], String(child.pid));
  setTimeout(() => {}, 60000);
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
