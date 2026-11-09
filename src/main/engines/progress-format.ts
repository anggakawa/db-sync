/** Number and label formatting shared by the engines' progress reports. */

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 1024-based: whole bytes and KB, one decimal from MB up (`512 KB`, `48.3 MB`, `2.3 GB`). */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  // Compare the rounded value, so 1,048,575 bytes reads 1.0 MB and never 1024 KB.
  const shown = (v: number, u: number) => (u >= 2 ? Math.round(v * 10) / 10 : Math.round(v));
  while (unit < units.length - 1 && shown(value, unit) >= 1024) { value /= 1024; unit += 1; }
  return unit >= 2 ? `${value.toFixed(1)} ${units[unit]}` : `${Math.round(value)} ${units[unit]}`;
}

export const readingLabel = (where: string): string => `Reading the table list from ${where}...`;

export const dumpTablesLabel = (prefix: string, done: number, total: number, bytes: number): string =>
  `${prefix}: ${formatCount(done)} of ${formatCount(total)} tables, ${formatSize(bytes)} so far`;

export const restoreTablesLabel = (done: number, total: number): string =>
  `Restoring: ${formatCount(done)} of ${formatCount(total)} tables`;

export const bytesProgressLabel = (prefix: string, bytes: number, estimate: number): string =>
  `${prefix}: ${formatSize(bytes)} of about ${formatSize(estimate)}`;

export const restoreBytesLabel = (bytes: number, total: number): string =>
  `Restoring: ${formatSize(bytes)} of ${formatSize(total)}`;
