const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const vaultConfig = require('../vault-config.cjs');

let mainWindow = null;
let safireServer = null;

function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : path.resolve(__dirname, '..');
}

function localPath(...parts) {
  return path.join(appRoot(), ...parts);
}

function useVault(vault) {
  const selected = path.resolve(vault);
  fs.mkdirSync(selected, { recursive: true });
  vaultConfig.saveVaultPath(selected);
  process.env.SAFIRE_VAULT_PATH = selected;
  return selected;
}

function ensureSafireVault() {
  if (!process.env.SAFIRE_VAULT_PATH && !vaultConfig.readVaultPath()) {
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      title: 'Choose your Safire vault',
      message: 'Where should Safire keep your Markdown notes?',
      detail: 'Safire stores notes as normal Markdown files. You can use the recommended Documents/Safire Vault location or choose an existing or new folder.',
      buttons: ['Use Documents/Safire Vault', 'Choose a folder'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) {
      const folders = dialog.showOpenDialogSync({
        title: 'Choose your Safire vault folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (folders?.[0]) return useVault(folders[0]);
    }
    return useVault(vaultConfig.defaultVaultPath());
  }
  const vault = vaultConfig.resolveVaultPath();
  fs.mkdirSync(vault, { recursive: true });
  process.env.SAFIRE_VAULT_PATH = vault;
  return vault;
}

async function startBackend() {
  const vault = ensureSafireVault();
  const serverPath = localPath('server.mjs');
  const mod = await import(pathToFileURL(serverPath).href);
  safireServer = await mod.startSafireServer({ vaultDir: vault, host: '127.0.0.1', port: 0 });
  return safireServer.url;
}

function changeVaultLocation() {
  const folders = dialog.showOpenDialogSync(mainWindow, {
    title: 'Choose a new Safire vault folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!folders?.[0]) return;
  const vault = useVault(folders[0]);
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Vault location updated',
    message: 'Safire will restart with the selected vault.',
    detail: vault,
  }).finally(() => {
    const portableLauncher = process.env.PORTABLE_EXECUTABLE_FILE;
    if (app.isPackaged && process.platform === 'win32' && portableLauncher && path.isAbsolute(portableLauncher) && fs.existsSync(portableLauncher)) {
      app.relaunch({ execPath: portableLauncher, args: process.argv.slice(1) });
    } else {
      app.relaunch();
    }
    app.exit(0);
  });
}

function openExternalUrl(rawUrl) {
  try {
    const target = new URL(rawUrl);
    if (['http:', 'https:', 'mailto:'].includes(target.protocol)) shell.openExternal(target.toString());
  } catch {
    // Ignore malformed or unsupported navigation targets.
  }
}

function openSafireHelp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript('window.dispatchEvent(new Event("safire:open-help"))').catch(() => {});
}

function createMenu() {
  const viewMenu = [
    { role: 'reload' },
    ...(!app.isPackaged ? [{ role: 'forceReload' }] : []),
    { type: 'separator' },
    { role: 'togglefullscreen' },
    ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
  ];
  const template = [
    {
      label: 'Safire',
      submenu: [
        { label: 'Open Vault Folder', click: () => shell.openPath(process.env.SAFIRE_VAULT_PATH) },
        { label: 'Change Vault Location…', click: changeVaultLocation },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: viewMenu,
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Safire Help', click: openSafireHelp },
        { type: 'separator' },
        { label: 'About Safire', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: 'About Safire', message: `Safire ${app.getVersion()}`, detail: 'A privacy-focused Markdown knowledge forge.\n\nCopyright (c) 2026 Safire\nSafire’s original project code is licensed under the MIT License.\n\nThird-party components are not relicensed by Safire and retain their own licenses and notices.' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const url = await startBackend();
  createMenu();
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    title: 'Safire',
    icon: localPath('public', process.platform === 'win32' ? 'app-icon.ico' : 'fire-icon.png'),
    backgroundColor: '#070812',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  const revealMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    mainWindow.show();
    mainWindow.focus();
  };
  mainWindow.once('ready-to-show', revealMainWindow);
  mainWindow.webContents.once('did-finish-load', revealMainWindow);
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    openExternalUrl(targetUrl);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const next = new URL(targetUrl);
      const home = new URL(url);
      if (next.origin !== home.origin) {
        event.preventDefault();
        openExternalUrl(targetUrl);
        return;
      }
      if (next.pathname.startsWith('/api/') && next.pathname !== '/api/attachment') {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });
  await mainWindow.loadURL(url);
  revealMainWindow();
}

app.setName('Safire');
app.whenReady().then(createWindow).catch((err) => {
  dialog.showErrorBox('Safire failed to start', String(err?.stack || err));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (safireServer?.server) safireServer.server.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
