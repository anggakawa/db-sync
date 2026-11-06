/** Replace every occurrence of each secret with ***, longest secret first. Empty secrets are ignored. */
export function redact(text: string, secrets: string[]): string {
  const ordered = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of ordered) result = result.split(secret).join('***');
  return result;
}

/** Copy of the environment without inherited PG*, MYSQL* and MARIADB* variables. */
export function cleanEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/^(PG|MYSQL|MARIADB)/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
