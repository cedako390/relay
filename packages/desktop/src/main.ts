import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { appUrl, ensureServer, type ServerHandle } from './server';

let server: ServerHandle | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

// Set by the dev supervisor (scripts/dev.mjs): the window shows the Vite dev server, and the backend is
// started and restarted by the supervisor, not by this process.
const devUrl = process.env.ORCH_DEV_URL;
const pageUrl = devUrl ?? appUrl;

function isOwnUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Orchestrator',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  // Without the default menu its reload accelerators are gone too; restore them (needed after `pnpm --filter @orch/web build`).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const reload = input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r');
    if (!reload) return;
    event.preventDefault();
    if (input.shift) win?.webContents.reloadIgnoringCache();
    else win?.webContents.reload();
  });
  win.on('closed', () => {
    win = null;
  });

  // The window only ever shows our own server; anything else opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isOwnUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  void win.loadURL(pageUrl);
}

ipcMain.handle('dialog:pick-folder', async (event: IpcMainInvokeEvent, defaultPath: unknown): Promise<string | null> => {
  // Only our own page may open native dialogs.
  if (!event.senderFrame || !isOwnUrl(event.senderFrame.url)) return null;
  const options = {
    title: 'Выберите папку',
    properties: ['openDirectory' as const, 'createDirectory' as const],
    // Without an explicit start folder the dialog would open in the app's own working directory.
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : app.getPath('desktop'),
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// A separate profile, so the dev window does not collide with a running app over the single-instance lock.
if (devUrl) app.setPath('userData', `${app.getPath('userData')}-dev`);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('before-quit', (event) => {
    if (quitting || !server?.owned) return;
    event.preventDefault();
    quitting = true;
    void server.stop().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(async () => {
    try {
      server = devUrl ? { owned: false, stop: async () => {} } : await ensureServer();
    } catch (err) {
      dialog.showErrorBox('Orchestrator', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
    createWindow();
  });
}
