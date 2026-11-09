import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage } from 'electron';
import { CHANNELS } from '../shared/api';
import type { Engine } from '../shared/types';
import { createMysqlAdapter } from './engines/mysql/mysql-adapter';
import { createPostgresAdapter } from './engines/postgres/postgres-adapter';
import { registerIpc } from './ipc';
import { createProfileStore, type Cipher } from './profiles/profile-store';
import { checkTargetHost } from './safety/target-guard';
import { createSyncPaths } from './sync/paths';
import { createLogStore } from './sync/sync-log';
import { createSyncRunner } from './sync/sync-runner';
import { createSyncService, type SyncService } from './sync/sync-service';
import { createToolLocator } from './tools/tool-locator';
import { windowWebPreferences } from './window-config';

// The smoke test points the app at a throwaway folder.
const userDataOverride = process.env['DBSYNC_USER_DATA'];
if (userDataOverride) app.setPath('userData', userDataOverride);

const safeCipher: Cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
};

/** Free bytes on the drive that holds `path`; a folder that does not exist yet is measured at its nearest parent. */
async function freeDiskBytes(path: string): Promise<number> {
  let dir = path;
  for (;;) {
    try {
      const s = await fs.statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch (err) {
      const parent = join(dir, '..');
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) throw err;
      dir = parent;
    }
  }
}

function buildService(send: (channel: string, ...args: unknown[]) => void): SyncService {
  const userData = app.getPath('userData');
  const paths = createSyncPaths(userData);
  const toolsRoot = app.isPackaged ? join(process.resourcesPath, 'tools') : join(app.getAppPath(), 'resources', 'tools');
  const locate = createToolLocator(toolsRoot);
  const adapters = {
    postgres: createPostgresAdapter({ locate, tmpRoot: paths.tmpRoot }),
    mysql: createMysqlAdapter({ locate, tmpRoot: paths.tmpRoot }),
  };
  const adapterFor = (engine: Engine) => adapters[engine];
  const checkTarget = (host: string) => checkTargetHost(host);
  return createSyncService({
    store: createProfileStore(paths.profilesFile, safeCipher),
    runner: createSyncRunner({ adapterFor, paths, checkTarget, freeDiskBytes }),
    paths,
    logs: createLogStore(paths, Date.now, app.getVersion()),
    adapterFor,
    checkTarget,
    onEvent: (id, event) => send(CHANNELS.syncEvent, id, event),
    onWarnings: (id, issues) => send(CHANNELS.warnings, id, issues),
  });
}

let mainWindow: BrowserWindow | null = null;
let service: SyncService | null = null;

/** The window and taskbar icon: bundled next to the tools when packaged, in build/icons while developing. */
function windowIcon(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons', 'app-icon.ico') : join(app.getAppPath(), 'build', 'icons', 'app-icon.ico');
}

function createWindow(svc: SyncService): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 900,
    minHeight: 640,
    icon: windowIcon(),
    webPreferences: { ...windowWebPreferences, preload: join(__dirname, '../preload/index.js') },
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  // Closing while a sync runs: ask, cancel, and wait for the outcome (automatic recovery included) before the window goes.
  let confirmed = false;
  let asking = false;
  win.on('close', (event) => {
    if (confirmed) return;
    if (!svc.hasRunningSync()) { svc.markClosing(); return; } // the window goes: no new sync from here
    event.preventDefault();
    if (asking) return;
    asking = true;
    void (async () => {
      try {
        const answer = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'A sync or restore is running',
          message: 'A sync or restore is running. Cancel it and close DB Sync?',
          detail: 'Closing cancels it. If the local database was already being replaced, its backup is put back where one exists; otherwise it may be left incomplete, and the app will offer to recover next time.',
          buttons: ['Cancel sync and close', 'Keep syncing'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (answer.response !== 0) { asking = false; return; }
        if (!win.isDestroyed()) win.setTitle('DB Sync - stopping the sync...');
        await svc.shutdown();
        confirmed = true;
        if (!win.isDestroyed()) win.close();
      } catch (err) {
        console.error('Closing the window failed:', err);
        asking = false;
      }
    })();
  });

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// One instance per userData folder: a second one would clear tmp and could drop the same target under a running sync.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); // no Reload or DevTools: a reload would lose a pending warnings prompt
    const send = (channel: string, ...args: unknown[]) => {
      const win = mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
    };
    const svc = buildService(send);
    service = svc;
    try {
      // Only now that this is the one instance: clear leftovers and repair an interrupted backup swap.
      for (const problem of await svc.startup()) console.error(problem);
    } catch (err) {
      console.error('Startup cleanup failed:', err);
    }
    registerIpc(ipcMain, svc, (e) => mainWindow !== null && e.sender === mainWindow.webContents);
    createWindow(svc); // always, even when cleanup had problems
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(svc);
    });
  });

  // Any other way to quit waits for a running sync: through the window when there is one, otherwise directly.
  app.on('before-quit', (event) => {
    if (!service?.hasRunningSync()) return;
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    } else {
      void service.shutdown().finally(() => app.quit());
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
