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

test('Safire stores vault selection in each platform native configuration directory', () => {
  const syntheticHome = path.resolve('synthetic-home');
  assert.equal(
    vaultConfig.vaultConfigPath({ platform: 'win32', home: syntheticHome, environment: {} }),
    path.join(syntheticHome, 'AppData', 'Local', 'Safire', 'vault.json'),
  );
  assert.equal(
    vaultConfig.vaultConfigPath({ platform: 'darwin', home: syntheticHome, environment: {} }),
    path.join(syntheticHome, 'Library', 'Application Support', 'Safire', 'vault.json'),
  );
  assert.equal(
    vaultConfig.vaultConfigPath({ platform: 'linux', home: syntheticHome, environment: {} }),
    path.join(syntheticHome, '.config', 'safire', 'vault.json'),
  );
  assert.equal(
    vaultConfig.vaultConfigPath({
      platform: 'linux',
      home: syntheticHome,
      environment: { XDG_CONFIG_HOME: path.join(syntheticHome, 'xdg') },
    }),
    path.join(syntheticHome, 'xdg', 'safire', 'vault.json'),
  );
});

test('starter notes are seeded only on first use and never resurrect after deletion', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-starter-state-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));

  const initialized = vaultConfig.initializeVault(vault);
  assert.equal(initialized, await fs.realpath(vault));
  assert.match(await fs.readFile(path.join(vault, 'Welcome.md'), 'utf8'), /^# Welcome to Safire/);
  assert.match(await fs.readFile(path.join(vault, 'Ideas.md'), 'utf8'), /^# Ideas/);

  await fs.writeFile(path.join(vault, 'Welcome.md'), '# My welcome\n', 'utf8');
  vaultConfig.initializeVault(vault);
  assert.equal(await fs.readFile(path.join(vault, 'Welcome.md'), 'utf8'), '# My welcome\n');

  await Promise.all([
    fs.rm(path.join(vault, 'Welcome.md')),
    fs.rm(path.join(vault, 'Ideas.md')),
    fs.rm(path.join(vault, 'Daily Notes'), { recursive: true }),
  ]);
  vaultConfig.initializeVault(vault);
  await assert.rejects(() => fs.access(path.join(vault, 'Welcome.md')), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(path.join(vault, 'Ideas.md')), { code: 'ENOENT' });
});

test('preexisting vault content is never supplemented with starter notes', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-existing-vault-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  await fs.writeFile(path.join(vault, 'Existing.md'), '# Existing\n', 'utf8');

  vaultConfig.initializeVault(vault);
  await assert.rejects(() => fs.access(path.join(vault, 'Welcome.md')), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(path.join(vault, 'Ideas.md')), { code: 'ENOENT' });

  await fs.rm(path.join(vault, 'Existing.md'));
  vaultConfig.initializeVault(vault);
  await assert.rejects(() => fs.access(path.join(vault, 'Welcome.md')), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(path.join(vault, 'Ideas.md')), { code: 'ENOENT' });
});
