const fs = require('fs');
const os = require('os');
const path = require('path');

const STARTER_STATE_DIRECTORY = '.safire';
const STARTER_STATE_FILE = 'starter-notes.json';
const WELCOME_NOTE = '# Welcome to Safire\n\nSafire is your privacy-focused, local-first Markdown workspace: warm, fast, portable, and yours.\n\n- Link notes with [[Ideas]]\n- Tag notes with #home or #projects\n- Use the graph view to see connections\n- Press Ctrl+K for the command palette\n- Press Ctrl+O for quick switcher\n- Press Ctrl+S to save\n\nCore note workflows stay on this computer. See PRIVACY.md for the network boundaries of optional features.\n';
const IDEAS_NOTE = '# Ideas\n\nThis note links back to [[Welcome]].\n\n#ideas\n';

function userHome(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  return options.home || (platform === 'win32' && environment.USERPROFILE ? environment.USERPROFILE : os.homedir());
}

function defaultVaultPath() {
  return path.join(userHome(), 'Documents', 'Safire Vault');
}

function vaultConfigPath(options = {}) {
  const environment = options.environment || process.env;
  const configured = options.configPath || environment.SAFIRE_VAULT_CONFIG_PATH;
  if (configured) return path.resolve(configured);
  const platform = options.platform || process.platform;
  const home = userHome({ ...options, platform, environment });
  if (platform === 'win32') return path.join(home, 'AppData', 'Local', 'Safire', 'vault.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Safire', 'vault.json');
  const configHome = environment.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.resolve(configHome, 'safire', 'vault.json');
}

function readVaultPath(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(vaultConfigPath(options), 'utf8'));
    if (typeof parsed.vaultPath !== 'string' || !parsed.vaultPath.trim()) return null;
    return path.resolve(parsed.vaultPath);
  } catch {
    return null;
  }
}

function saveVaultPath(rawVaultPath, options = {}) {
  if (typeof rawVaultPath !== 'string' || !rawVaultPath.trim()) throw new Error('A vault folder is required');
  const selected = path.resolve(rawVaultPath.trim());
  const configPath = vaultConfigPath(options);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, vaultPath: selected }, null, 2), 'utf8');
  return selected;
}

function resolveVaultPath(options = {}) {
  const explicit = options.vaultDir || process.env.SAFIRE_VAULT_PATH;
  return path.resolve(explicit || readVaultPath(options) || defaultVaultPath());
}

function ensurePlainDirectory(directory) {
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Safire internal paths cannot use symlinks or junctions');
  }
}

function readStarterState(statePath) {
  try {
    const metadata = fs.lstatSync(statePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Safire starter state must be a plain file');
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return parsed?.version === 1 && parsed?.state === 'seeding' ? 'seeding' : 'initialized';
    } catch (error) {
      if (error instanceof SyntaxError) return 'initialized';
      throw error;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function starterStateJson(state) {
  return `${JSON.stringify({ version: 1, state }, null, 2)}\n`;
}

function hasExistingVaultContent(vaultDir) {
  for (const entry of fs.readdirSync(vaultDir, { withFileTypes: true })) {
    if (entry.name !== STARTER_STATE_DIRECTORY) return true;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Safire internal paths cannot use symlinks or junctions');
    }
    const internalEntries = fs.readdirSync(path.join(vaultDir, STARTER_STATE_DIRECTORY));
    if (internalEntries.some(name => name !== STARTER_STATE_FILE)) return true;
  }
  return false;
}

function createStarterFile(target, content) {
  try {
    fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

function initializeVault(rawVaultPath) {
  const requestedVault = path.resolve(rawVaultPath);
  fs.mkdirSync(requestedVault, { recursive: true });
  const vaultDir = fs.realpathSync(requestedVault);
  const stateDirectory = path.join(vaultDir, STARTER_STATE_DIRECTORY);
  ensurePlainDirectory(stateDirectory);
  const statePath = path.join(stateDirectory, STARTER_STATE_FILE);
  let state = readStarterState(statePath);

  if (state === null) {
    const firstUse = !hasExistingVaultContent(vaultDir);
    try {
      state = firstUse ? 'seeding' : 'initialized';
      fs.writeFileSync(statePath, starterStateJson(state), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      state = readStarterState(statePath);
    }
  }

  if (state === 'seeding') {
    createStarterFile(path.join(vaultDir, 'Welcome.md'), WELCOME_NOTE);
    createStarterFile(path.join(vaultDir, 'Ideas.md'), IDEAS_NOTE);
    fs.writeFileSync(statePath, starterStateJson('initialized'), 'utf8');
  }

  fs.mkdirSync(path.join(vaultDir, 'Daily Notes'), { recursive: true });
  return vaultDir;
}

module.exports = {
  defaultVaultPath,
  initializeVault,
  readVaultPath,
  resolveVaultPath,
  saveVaultPath,
  vaultConfigPath,
};
