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
  const selected = vaultConfig.saveVaultPath(vault);
  fs.mkdirSync(selected, { recursive: true });
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
    app.relaunch();
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

function createMenu() {
  const guidePath = localPath('docs', 'Safire User Guide.html');
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
        { label: 'Open User Guide', click: () => shell.openPath(guidePath) },
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
        { label: 'Safire User Guide', click: () => shell.openPath(guidePath) },
        { label: 'About Safire', click: () => dialog.showMessageBox({ type: 'info', title: 'Safire', message: 'Safire', detail: 'A privacy-focused, local-first Markdown knowledge forge. Local files. Connected thinking.' }) },
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
  mainWindow.once('ready-to-show', () => mainWindow.show());
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
