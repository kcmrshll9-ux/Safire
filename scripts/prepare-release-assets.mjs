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

const notes = `Safire ${version} brings the local-first Markdown workspace to Windows, macOS, and Linux.

## Highlights

- Added native desktop packages for macOS on Apple Silicon and Intel.
- Added Linux AppImage and Debian packages for x64 systems.
- Added platform-native launchers for the optional packaged memory MCP runtime.
- Extended CI and packaged security validation across all supported operating systems and architectures.

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

- [MIT License](https://github.com/kcmrshll9-ux/Safire/blob/v${version}/LICENSE)
- [Full changes since 1.4.2](https://github.com/kcmrshll9-ux/Safire/compare/v1.4.2...v${version})
`;

await fs.writeFile(notesPath, notes, 'utf8');
process.stdout.write(`Prepared ${expectedArtifacts.length + 1} release assets for Safire ${version}.\n`);
