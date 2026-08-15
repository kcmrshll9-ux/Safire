import fs from 'node:fs/promises';
import path from 'node:path';
import { createNoteMutator } from '../lib/note-mutations.mjs';

const [vaultDir, notePath, label, holdTransform = '0'] = process.argv.slice(2);
function pathKey(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}
const lockPath = pathKey(path.join(path.resolve(vaultDir), '.safire-note-mutations.lock'));
let releaseTransform;
const transformGate = new Promise((resolve) => { releaseTransform = resolve; });
let contentionReported = false;

const observedFs = {
  ...fs,
  async mkdir(target, options) {
    try {
      return await fs.mkdir(target, options);
    } catch (error) {
      if (!contentionReported && error?.code === 'EEXIST' && pathKey(String(target)) === lockPath) {
        contentionReported = true;
        process.send?.({ type: 'contended' });
      }
      throw error;
    }
  },
};

process.on('message', (message) => {
  if (message === 'release') releaseTransform();
  if (message === 'start') {
    const mutator = createNoteMutator({
      vaultDir,
      fsApi: observedFs,
      lockOptions: { timeoutMs: 30_000, retryDelayMs: 5 },
    });
    void mutator.mutate(notePath, async (current) => {
      process.send?.({ type: 'transform', content: current.toString('utf8') });
      if (holdTransform === '1') await transformGate;
      return `${current.toString('utf8')}${label}\n`;
    }).then(
      (result) => process.send?.({ type: 'done', result }, () => process.disconnect()),
      (error) => process.send?.({ type: 'error', code: error?.code, message: error?.message }, () => process.disconnect()),
    );
  }
});

process.send?.({ type: 'ready' });
