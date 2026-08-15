import { promises as fs } from 'node:fs';
import path from 'node:path';

import { acquireVaultLock, ensureMemoryLayout } from '../lib/memory/filesystem.mjs';

const vault = process.argv[2];
if (typeof vault !== 'string' || !vault) throw new Error('A vault path is required');
const releasePauseStage = process.argv[3] || null;
if (releasePauseStage !== null && ![
  'before_owner_unlink',
  'before_gate_rmdir',
].includes(releasePauseStage)) {
  throw new Error('An unsupported release pause stage was requested');
}

const layout = await ensureMemoryLayout(vault);
const lock = await acquireVaultLock(layout, {
  timeoutMs: 2_000,
  retryDelayMs: 5,
});

process.stdout.write('LOCKED\n');

function pauseRelease(label) {
  process.stdout.write(`${label}\n`);
  return new Promise(() => {});
}

function installReleasePause() {
  if (releasePauseStage === 'before_owner_unlink') {
    const originalUnlink = fs.unlink;
    fs.unlink = async (target, ...args) => {
      if (typeof target === 'string'
          && path.dirname(target) === layout.lockPath
          && /^owner-[a-f0-9]{64}\.json$/.test(path.basename(target))) {
        return pauseRelease('BEFORE_OWNER_UNLINK');
      }
      return originalUnlink(target, ...args);
    };
  } else if (releasePauseStage === 'before_gate_rmdir') {
    const originalRmdir = fs.rmdir;
    fs.rmdir = async (target, ...args) => {
      if (typeof target === 'string' && path.resolve(target) === path.resolve(layout.lockPath)) {
        return pauseRelease('BEFORE_GATE_RMDIR');
      }
      return originalRmdir(target, ...args);
    };
  }
}

const keepAlive = setInterval(() => {}, 1_000);
let input = '';
let releasing = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  input += chunk;
  if (releasing || !input.includes('RELEASE\n')) return;
  releasing = true;
  try {
    installReleasePause();
    await lock.release();
    clearInterval(keepAlive);
    process.stdin.destroy();
    process.stdout.write('RELEASED\n');
  } catch {
    process.stderr.write('Lock release failed\n');
    process.exitCode = 1;
    clearInterval(keepAlive);
    process.stdin.destroy();
  }
});
