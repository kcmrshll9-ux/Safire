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
    'Safire-Setup-1.6.0.exe',
    'Safire-Portable-1.6.0.exe',
    'Safire-1.6.0-linux-x64.AppImage',
    'Safire-1.6.0-linux-x64.deb',
    'Safire-1.6.0-macos-x64.dmg',
    'Safire-1.6.0-macos-arm64.dmg',
  ];
  await Promise.all(names.map((name) => fs.writeFile(path.join(artifacts, name), `synthetic:${name}`, 'utf8')));

  await execFileAsync(process.execPath, [preparer, artifacts, '1.6.0', notes], { cwd: projectRoot });

  const manifest = await fs.readFile(path.join(artifacts, 'Safire-1.6.0-checksums.txt'), 'utf8');
  const lines = manifest.trim().split(/\r?\n/);
  assert.equal(lines.length, names.length);
  for (const name of names) {
    assert.match(manifest, new RegExp(`[A-F0-9]{64} \\*${name.replaceAll('.', '\\.')}($|\\r?\\n)`));
  }

  const releaseNotes = await fs.readFile(notes, 'utf8');
  assert.match(releaseNotes, /^Safire 1\.6\.0 brings a calmer, more focused Markdown workspace to Windows, macOS, and Linux\./);
  assert.match(releaseNotes, /overflow menus/);
  assert.match(releaseNotes, /8-pixel spacing scale/);
  assert.match(releaseNotes, /searchable Help Center/);
  assert.match(releaseNotes, /Hermes\/OpenClaw setup/);
  assert.match(releaseNotes, /named projects/);
  assert.match(releaseNotes, /backup-before-delete controls/);
  assert.match(releaseNotes, /every project graph/);
  assert.match(releaseNotes, /all valid in-project connections are shown/);
  assert.match(releaseNotes, /configured daily-notes folder/);
  assert.match(releaseNotes, /starter notes first-use-only/);
  assert.match(releaseNotes, /Windows portable startup/);
  assert.match(releaseNotes, /not code-signed/);
  assert.match(releaseNotes, /Safire-1\.6\.0-macos-arm64\.dmg/);
  assert.match(releaseNotes, /Safire-1\.6\.0-linux-x64\.AppImage/);
});

test('public 1.6.0 highlights describe the shipped project and platform behavior', async () => {
  const [readme, changelog, factSheet, boilerplate, pressKit] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'CHANGELOG.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'press-kit', 'Safire Fact Sheet.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'press-kit', 'Safire Boilerplate.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'press-kit', 'Safire Press Kit.html'), 'utf8'),
  ]);

  assert.match(readme, /CHANGELOG\.md#160---2026-08-20/);
  assert.match(readme, /More reliable Windows portable startup/);
  assert.match(changelog, /outer portable application/);
  assert.match(factSheet, /separate two-dimensional, force-directed relationship graph for each project/);
  assert.match(factSheet, /Recognized YouTube links use a local placeholder/);
  assert.match(boilerplate, /Named projects keep their entries and relationship graphs separate/);
  assert.match(pressKit, /A separate two-dimensional graph for each project/);
  assert.match(pressKit, /MIT License grants rights to Safire branding/);
  assert.doesNotMatch(`${factSheet}\n${pressKit}`, /global graph|global and local graph|local and global graph|remote thumbnails|calling Safire open source/i);
});
