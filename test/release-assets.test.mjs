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
const previousVersion = '1.6.0';

test('multi-platform release assets receive a complete deterministic checksum manifest and notes', async (t) => {
  assert.equal(packageVersion, '1.6.1');
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
  assert.ok(releaseNotes.startsWith(`Safire ${packageVersion} makes dense project graphs easier to read`));
  assert.match(releaseNotes, /folder-clustered Project map/);
  assert.match(releaseNotes, /explicit folder controls/);
  assert.match(releaseNotes, /Full graph lossless/);
  assert.match(releaseNotes, /mouse-rotatable perspective 3D/);
  assert.match(releaseNotes, /native or in-window full-screen graph viewing/);
  assert.match(releaseNotes, /keyboard controls/);
  assert.match(releaseNotes, /equivalent wiki-link spellings/);
  assert.match(releaseNotes, /source-to-target edges draw once/);
  assert.match(releaseNotes, /Preserved project isolation/);
  assert.match(releaseNotes, /does not rewrite project notes/);
  assert.match(releaseNotes, /not code-signed/);
  assert.match(releaseNotes, new RegExp(`Safire-${packageVersion.replaceAll('.', '\\.')}-macos-arm64\\.dmg`));
  assert.match(releaseNotes, new RegExp(`Safire-${packageVersion.replaceAll('.', '\\.')}-linux-x64\\.AppImage`));
  assert.match(releaseNotes, new RegExp(`compare/v${previousVersion.replaceAll('.', '\\.')}\\.\\.\\.v${packageVersion.replaceAll('.', '\\.')}`));
  assert.match(releaseNotes, /https:\/\/x\.com\/run4ourfun/);
});

test('public 1.6.1 surfaces describe the shipped graph behavior consistently', async () => {
  const [readme, changelog, docsReadme, pressReadme, factSheet, boilerplate, brandNotes, pressKit, issueTemplate] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'CHANGELOG.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'docs', 'README.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'press-kit', 'README.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'press-kit', 'Safire Fact Sheet.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'press-kit', 'Safire Boilerplate.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'press-kit', 'Safire Brand Notes.md'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'press-kit', 'Safire Press Kit.html'), 'utf8'),
    fs.readFile(path.join(projectRoot, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), 'utf8'),
  ]);

  assert.match(readme, /Version 1\.6\.1/);
  assert.match(readme, /CHANGELOG\.md#161---2026-08-20/);
  assert.match(readme, /mouse-rotatable perspective 3D/);
  assert.match(readme, /More reliable Windows portable startup/);
  assert.match(changelog, /folder-clustered Project map/);
  assert.match(changelog, /mouse-rotatable, full-screen 3D Full graph view/);
  assert.match(changelog, /equivalent wiki-link spellings/);
  assert.match(changelog, /reciprocal links remain distinct/);
  assert.match(docsReadme, /defaults to a deterministic two-dimensional Project map/);
  assert.match(factSheet, /deterministic two-dimensional Project map/);
  assert.match(factSheet, /lossless Full graph with optional mouse-rotatable perspective 3D/);
  assert.match(factSheet, /Recognized YouTube links use a local placeholder/);
  assert.match(boilerplate, /Safire 1\.6\.1 makes dense Markdown project graphs readable/);
  assert.match(pressKit, /lossless, mouse-rotatable perspective 3D Full graph/);
  assert.match(pressKit, /MIT License grants rights to Safire branding/);
  assert.match(issueTemplate, /placeholder: 1\.6\.1/);
  assert.match(readme, /https:\/\/x\.com\/run4ourfun/);
  assert.match(factSheet, /https:\/\/x\.com\/run4ourfun/);
  assert.match(pressKit, /https:\/\/x\.com\/run4ourfun/);
  assert.doesNotMatch(`${factSheet}\n${pressKit}`, /global graph|global and local graph|local and global graph|remote thumbnails|calling Safire open source/i);
  assert.doesNotMatch([readme, docsReadme, pressReadme, factSheet, boilerplate, brandNotes, pressKit, issueTemplate].join('\n'), /\b1\.6\.0\b/);
});
