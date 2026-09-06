import fs from 'node:fs/promises';
import path from 'node:path';
import { assertContainedPath, createNoteMutator, readContainedFile } from './note-mutations.mjs';

const CONFIG_FILES = new Set(['settings.json', 'workspace.json', 'web-clip-templates.json']);
const MAX_CONFIG_BYTES = 1024 * 1024;
const byteLimit = name => name === 'web-clip-templates.json' ? 8 * MAX_CONFIG_BYTES : MAX_CONFIG_BYTES;
function tooLarge() {
  const error = new Error('Vault configuration is too large; the existing file has been preserved');
  error.code = 'VAULT_CONFIG_TOO_LARGE';
  return error;
}

// Configuration has the same containment boundary as notes. Check the parent
// and the complete leaf on every operation, including after vault startup.
export function createVaultJsonStore(vault) {
  const root = path.join(vault, '.safire');
  const mutator = createNoteMutator({ vaultDir: root, backupWrites: false });
  async function target(name) {
    if (!CONFIG_FILES.has(name)) throw new Error('Unknown vault configuration file');
    const file = path.join(root, name);
    await assertContainedPath(vault, file, { allowMissing: true });
    await fs.mkdir(root, { recursive: true });
    await assertContainedPath(vault, file, { allowMissing: true });
    return file;
  }
  function encode(name, value) {
    const text = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(text) > byteLimit(name)) throw tooLarge();
    return text;
  }
  async function read(name, fallback, { initialize = false } = {}) {
    const file = await target(name);
    let text;
    try { text = await readContainedFile(vault, file, 'utf8', { maxBytes: byteLimit(name) }); }
    catch (error) {
      if (error.message === 'The requested item is too large') throw tooLarge();
      if (error.code !== 'ENOENT') throw error;
      if (initialize) {
        try { await mutator.create(file, encode(name, fallback)); }
        catch (creationError) {
          if (creationError.code !== 'EEXIST') throw creationError;
          return read(name, fallback);
        }
      }
      return structuredClone(fallback);
    }
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : structuredClone(fallback);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A damaged file is preserved until an explicit settings/workspace write.
      return structuredClone(fallback);
    }
  }
  return {
    read,
    async write(name, value) {
      const file = await target(name);
      await mutator.put(file, encode(name, value));
    },
  };
}
