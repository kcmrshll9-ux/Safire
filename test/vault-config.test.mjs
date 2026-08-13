import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vaultConfig from '../vault-config.cjs';

test('Safire vault selection persists independently of the vault itself', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-vault-config-test-'));
  const configPath = path.join(root, 'app-state', 'vault.json');
  const chosenVault = path.join(root, 'My Notes');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const expectedHome = process.platform === 'win32' && process.env.USERPROFILE ? process.env.USERPROFILE : os.homedir();
  assert.equal(vaultConfig.defaultVaultPath(), path.join(expectedHome, 'Documents', 'Safire Vault'));
  assert.equal(vaultConfig.readVaultPath({ configPath }), null);
  assert.equal(vaultConfig.saveVaultPath(chosenVault, { configPath }), path.resolve(chosenVault));
  assert.equal(vaultConfig.readVaultPath({ configPath }), path.resolve(chosenVault));
  assert.equal(vaultConfig.resolveVaultPath({ configPath }), path.resolve(chosenVault));
  assert.equal(vaultConfig.resolveVaultPath({ vaultDir: path.join(root, 'One-off Vault'), configPath }), path.resolve(root, 'One-off Vault'));
});
