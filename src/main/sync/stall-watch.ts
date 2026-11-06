import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** Size of a file or, recursively, of a directory. 0 when it does not exist. */
export async function sizeOf(path: string): Promise<number> {
  let st;
  try { st = await fs.stat(path); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await fs.readdir(path).catch(() => [] as string[])) total += await sizeOf(join(path, name));
  return total;
}

/** Calls onStall once when `measure` has not grown for `limitMs`. Returns a function that stops the watch. */
export function watchStall(
  measure: () => Promise<number>, limitMs: number, onStall: () => void, pollMs = 10_000,
): () => void {
  let stopped = false;
  let polling = false;
  let last = -1;
  let lastGrowth = Date.now();
  const timer = setInterval(async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      let size = last;
      try { size = await measure(); } catch { /* a failed read counts as no growth */ }
      if (stopped) return;
      if (size > last) { last = size; lastGrowth = Date.now(); return; }
      if (Date.now() - lastGrowth >= limitMs) { stopped = true; clearInterval(timer); onStall(); }
    } finally { polling = false; }
  }, pollMs);
  return () => { stopped = true; clearInterval(timer); };
}
