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
const packageVersion = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
const previousVersion = '1.6.2';

test('multi-platform release assets receive a complete deterministic checksum manifest and notes', async (t) => {
  assert.equal(packageVersion, '1.7.0');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-release-assets-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const artifacts = path.join(scratch, 'artifacts');
  const notes = path.join(scratch, 'notes.md');
  await fs.mkdir(artifacts);

  const names = [
    `Safire-Setup-${packageVersion}.exe`,
    `Safire-Portable-${packageVersion}.exe`,
    `Safire-${packageVersion}-linux-x64.AppImage`,
    `Safire-${packageVersion}-linux-x64.deb`,
    `Safire-${packageVersion}-macos-x64.dmg`,
    `Safire-${packageVersion}-macos-arm64.dmg`,
  ];
  await Promise.all(names.map((name) => fs.writeFile(path.join(artifacts, name), `synthetic:${name}`, 'utf8')));

  await execFileAsync(process.execPath, [preparer, artifacts, packageVersion, notes], { cwd: projectRoot });

  const manifest = await fs.readFile(path.join(artifacts, `Safire-${packageVersion}-checksums.txt`), 'utf8');
  const lines = manifest.trim().split(/\r?\n/);
  assert.equal(lines.length, names.length);
  for (const name of names) {
    assert.match(manifest, new RegExp(`[A-F0-9]{64} \\*${name.replaceAll('.', '\\.')}($|\\r?\\n)`));
  }

  const releaseNotes = await fs.readFile(notes, 'utf8');
  assert.ok(releaseNotes.startsWith(`Safire ${packageVersion} brings protected writing`));
  assert.match(releaseNotes, /Protected drafts/);
  assert.match(releaseNotes, /Security and reliability/);
  assert.match(releaseNotes, /not code-signed/);
  assert.match(releaseNotes, new RegExp(`Safire-${packageVersion.replaceAll('.', '\\.')}-macos-arm64\\.dmg`));
  assert.match(releaseNotes, new RegExp(`Safire-${packageVersion.replaceAll('.', '\\.')}-linux-x64\\.AppImage`));
  assert.match(releaseNotes, new RegExp(`compare/v${previousVersion.replaceAll('.', '\\.')}\\.\\.\\.v${packageVersion.replaceAll('.', '\\.')}`));
  assert.match(releaseNotes, /https:\/\/x\.com\/run4ourfun/);
});

test('release identity matches package, lockfile, MCP, release notes and current product documents', async () => {
  const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, packageVersion);
  assert.equal(lock.packages[''].version, packageVersion);
  for (const relative of ['safire-mcp.mjs', 'lib/memory/mcp.mjs', 'README.md', 'docs/README.md', 'docs/PRODUCT_WORK.md', 'press-kit/README.md', 'press-kit/Safire Fact Sheet.md', 'press-kit/Safire Boilerplate.md', 'press-kit/Safire Brand Notes.md', 'press-kit/Safire Press Kit.html', '.github/ISSUE_TEMPLATE/bug_report.yml']) {
    assert.ok((await fs.readFile(path.join(projectRoot, relative), 'utf8')).includes(packageVersion), `Version missing from ${relative}`);
  }
  const changelog = await fs.readFile(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(`## [${packageVersion}] - 2026-09-06`));
  assert.ok(changelog.includes(`## [${previousVersion}]`), 'Keep the historical release record');
  const readme = await fs.readFile(path.join(projectRoot, 'README.md'), 'utf8');
  assert.ok(readme.includes(`releases/tag/v${packageVersion}`));
  assert.doesNotMatch(readme, /not yet a tagged release|working product preview/i);
  const releaseNotes = await fs.readFile(path.join(projectRoot, 'docs/releases', `${packageVersion}.md`), 'utf8');
  assert.match(releaseNotes, /local plaintext/);
  assert.match(releaseNotes, /does not add cloud sync/);
});
