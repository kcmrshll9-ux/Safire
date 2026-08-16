import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preparer = path.join(projectRoot, 'scripts', 'prepare-release-assets.mjs');

test('multi-platform release assets receive a complete deterministic checksum manifest and notes', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-release-assets-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const artifacts = path.join(scratch, 'artifacts');
  const notes = path.join(scratch, 'notes.md');
  await fs.mkdir(artifacts);

  const names = [
    'Safire-Setup-1.5.0.exe',
    'Safire-Portable-1.5.0.exe',
    'Safire-1.5.0-linux-x64.AppImage',
    'Safire-1.5.0-linux-x64.deb',
    'Safire-1.5.0-macos-x64.dmg',
    'Safire-1.5.0-macos-arm64.dmg',
  ];
  await Promise.all(names.map((name) => fs.writeFile(path.join(artifacts, name), `synthetic:${name}`, 'utf8')));

  await execFileAsync(process.execPath, [preparer, artifacts, '1.5.0', notes], { cwd: projectRoot });

  const manifest = await fs.readFile(path.join(artifacts, 'Safire-1.5.0-checksums.txt'), 'utf8');
  const lines = manifest.trim().split(/\r?\n/);
  assert.equal(lines.length, names.length);
  for (const name of names) {
    assert.match(manifest, new RegExp(`[A-F0-9]{64} \\*${name.replaceAll('.', '\\.')}($|\\r?\\n)`));
  }

  const releaseNotes = await fs.readFile(notes, 'utf8');
  assert.match(releaseNotes, /^Safire 1\.5\.0 brings the local-first Markdown workspace to Windows, macOS, and Linux\./);
  assert.match(releaseNotes, /not code-signed/);
  assert.match(releaseNotes, /Safire-1\.5\.0-macos-arm64\.dmg/);
  assert.match(releaseNotes, /Safire-1\.5\.0-linux-x64\.AppImage/);
});
