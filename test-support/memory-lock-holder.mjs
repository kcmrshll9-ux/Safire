import { acquireVaultLock, ensureMemoryLayout } from '../lib/memory/filesystem.mjs';

const vault = process.argv[2];
if (typeof vault !== 'string' || !vault) throw new Error('A vault path is required');

const layout = await ensureMemoryLayout(vault);
const lock = await acquireVaultLock(layout, {
  timeoutMs: 2_000,
  retryDelayMs: 5,
  staleMs: 60_000,
});

process.stdout.write('LOCKED\n');

const keepAlive = setInterval(() => {}, 1_000);
let input = '';
let releasing = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  input += chunk;
  if (releasing || !input.includes('RELEASE\n')) return;
  releasing = true;
  try {
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
