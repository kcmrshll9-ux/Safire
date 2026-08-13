const fs = require('fs');
const os = require('os');
const path = require('path');

function userHome() {
  return process.platform === 'win32' && process.env.USERPROFILE ? process.env.USERPROFILE : os.homedir();
}

function defaultVaultPath() {
  return path.join(userHome(), 'Documents', 'Safire Vault');
}

function vaultConfigPath(options = {}) {
  const configured = options.configPath || process.env.SAFIRE_VAULT_CONFIG_PATH;
  return path.resolve(configured || path.join(userHome(), 'AppData', 'Local', 'Safire', 'vault.json'));
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

module.exports = { defaultVaultPath, vaultConfigPath, readVaultPath, saveVaultPath, resolveVaultPath };
