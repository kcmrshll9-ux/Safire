import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const [artifactDirectoryArgument, version, notesPathArgument] = process.argv.slice(2);

if (!artifactDirectoryArgument || !/^\d+\.\d+\.\d+$/.test(version || '') || !notesPathArgument) {
  throw new Error('Usage: node scripts/prepare-release-assets.mjs <artifact-directory> <version> <notes-path>');
}

const artifactDirectory = path.resolve(artifactDirectoryArgument);
const notesPath = path.resolve(notesPathArgument);
const expectedArtifacts = [
  `Safire-Setup-${version}.exe`,
  `Safire-Portable-${version}.exe`,
  `Safire-${version}-linux-x64.AppImage`,
  `Safire-${version}-linux-x64.deb`,
  `Safire-${version}-macos-x64.dmg`,
  `Safire-${version}-macos-arm64.dmg`,
].sort();

const actualArtifacts = (await fs.readdir(artifactDirectory)).sort();
if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) {
  throw new Error(`Unexpected release artifact set:\n${actualArtifacts.join('\n')}`);
}

const checksumLines = [];
for (const name of expectedArtifacts) {
  const bytes = await fs.readFile(path.join(artifactDirectory, name));
  if (bytes.length === 0) throw new Error(`Release artifact is empty: ${name}`);
  const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  checksumLines.push(`${digest} *${name}`);
}

const checksumName = `Safire-${version}-checksums.txt`;
await fs.writeFile(path.join(artifactDirectory, checksumName), `${checksumLines.join('\n')}\n`, 'utf8');

const previousVersion = '1.6.0';

const notes = `Safire ${version} makes dense project graphs easier to read while keeping every project relationship available on Windows, macOS, and Linux.

## Highlights

- Added a deterministic, folder-clustered Project map as the readable first-open graph view.
- Grouped lower-priority notes behind explicit folder controls while keeping selected-note connections and every immediate hub relationship available.
- Kept Full graph lossless so every matching note and directed wiki-link relationship remains available.
- Added mouse-rotatable perspective 3D to Full graph, with Shift-drag panning, wheel zoom, depth-aware node dragging, and a reset control.
- Added direct native or in-window full-screen graph viewing, plus keyboard controls for full screen, rotation, reset, pan, and zoom.
- Deduplicated equivalent wiki-link spellings by canonical directed endpoints so repeated source-to-target edges draw once while reciprocal links stay distinct.
- Preserved project isolation, project-relative wikilink resolution, and user vault data; the update does not rewrite project notes.

## Downloads

### Windows x64

- **Safire-Setup-${version}.exe** — recommended Windows installer.
- **Safire-Portable-${version}.exe** — portable Windows application.

### macOS

- **Safire-${version}-macos-arm64.dmg** — Apple Silicon Macs.
- **Safire-${version}-macos-x64.dmg** — Intel Macs.

### Linux x64

- **Safire-${version}-linux-x64.AppImage** — portable Linux application.
- **Safire-${version}-linux-x64.deb** — Debian and Ubuntu package.

- **Safire-${version}-checksums.txt** — SHA-256 verification manifest for every download.

> [!IMPORTANT]
> The Windows and macOS applications are not code-signed. Windows SmartScreen or macOS Gatekeeper may display a warning. Download Safire only from this official GitHub release and verify the SHA-256 checksum.

## More information

- [Contact Safire on X: @run4ourfun](https://x.com/run4ourfun)
- [MIT License](https://github.com/kcmrshll9-ux/Safire/blob/v${version}/LICENSE)
- [Full changes since ${previousVersion}](https://github.com/kcmrshll9-ux/Safire/compare/v${previousVersion}...v${version})
`;

await fs.writeFile(notesPath, notes, 'utf8');
process.stdout.write(`Prepared ${expectedArtifacts.length + 1} release assets for Safire ${version}.\n`);
