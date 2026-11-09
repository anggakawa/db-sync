import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import pg from 'pg';
import { REPO_ROOT, startTempServer, type TempServer } from '../integration/harness/temp-server';

const EXE = join(REPO_ROOT, 'release', 'win-unpacked', 'DB Sync.exe');

async function connect(server: TempServer, database: string): Promise<pg.Client> {
  const client = new pg.Client({ host: server.host, port: server.port, user: server.user, password: server.password, database });
  await client.connect();
  return client;
}

test('packaged app: sync, no password on disk, restore', async () => {
  let source: TempServer | undefined;
  let target: TempServer | undefined;
  let app: ElectronApplication | undefined;
  let userData: string | undefined;
  try {
    source = await startTempServer('postgres');
    target = await startTempServer('postgres');
    // Plain databases created by this test on servers this test started.
    for (const [server, name] of [[source, 'devdb'], [target, 'localdb']] as const) {
      const admin = await connect(server, 'postgres');
      await admin.query(`CREATE DATABASE ${name}`);
      await admin.end();
    }
    const s = await connect(source, 'devdb');
    await s.query('CREATE TABLE items (id int PRIMARY KEY, label text)');
    await s.query("INSERT INTO items VALUES (1, 'from dev'), (2, 'also from dev'), (3, 'dev again')");
    await s.end();
    const t = await connect(target, 'localdb');
    await t.query('CREATE TABLE old_items (id int PRIMARY KEY, label text)');
    await t.query("INSERT INTO old_items VALUES (10, 'earlier local row'), (11, 'another earlier row')");
    await t.end();

    userData = await fs.mkdtemp(join(tmpdir(), 'dbsync-smoke-'));
    userData = join(userData, 'dá ta sync');
    app = await electron.launch({ executablePath: EXE, env: { ...process.env, DBSYNC_USER_DATA: userData } as Record<string, string> });
    const page: Page = await app.firstWindow();

    await page.getByRole('button', { name: 'New profile' }).click();
    await page.getByLabel('Profile name').fill('smoke');
    const fillSide = async (side: 'source' | 'target', server: TempServer, database: string) => {
      const box = page.locator(`fieldset.${side}`);
      await box.getByLabel('Host').fill(server.host);
      await box.getByLabel('Port').fill(String(server.port));
      await box.getByLabel('User').fill(server.user);
      await box.getByLabel('Password', { exact: true }).fill(server.password);
      await box.getByLabel('Database name').fill(database);
    };
    await fillSide('source', source, 'devdb');
    await fillSide('target', target, 'localdb');
    await page.getByRole('button', { name: 'Save' }).click();

    await page.getByRole('button', { name: 'Sync' }).click();
    await expect(page.getByRole('dialog')).toContainText('Overwrite');
    await page.getByRole('button', { name: 'Overwrite' }).click();
    await expect(page.getByText(/Done in/)).toBeVisible({ timeout: 120_000 });

    const after = await connect(target, 'localdb');
    const rows = await after.query('SELECT id, label FROM items ORDER BY id');
    expect(rows.rows).toEqual([{ id: 1, label: 'from dev' }, { id: 2, label: 'also from dev' }, { id: 3, label: 'dev again' }]);
    await after.end();

    const profiles = await fs.readFile(join(userData, 'profiles.json'), 'utf8');
    expect(profiles).not.toContain(source.password);
    expect(profiles).not.toContain(target.password);

    await expect(page.getByRole('button', { name: 'Restore previous local data' })).toBeVisible();
    await page.getByRole('button', { name: 'Restore previous local data' }).click();
    await expect(page.getByRole('dialog')).toContainText('Restore');
    await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByText(/Done in/).first()).toBeVisible({ timeout: 120_000 });

    await expect.poll(async () => {
      const c = await connect(target!, 'localdb');
      try {
        const r = await c.query('SELECT id, label FROM old_items ORDER BY id');
        return r.rows;
      } catch { return null; } finally { await c.end(); }
    }, { timeout: 60_000 }).toEqual([{ id: 10, label: 'earlier local row' }, { id: 11, label: 'another earlier row' }]);

    // Nothing sensitive or bulky is left in the working folder.
    const left = await fs.readdir(join(userData, 'tmp')).catch(() => [] as string[]);
    expect(left.filter((n) => /^client-.*\.cnf$/.test(n) || n.endsWith('.dump'))).toEqual([]);
    expect(left).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await target?.stop().catch(() => undefined);
    await source?.stop().catch(() => undefined);
    if (userData) await fs.rm(join(userData, '..'), { recursive: true, force: true }).catch(() => undefined);
  }
});
