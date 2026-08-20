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

const notes = `Safire ${version} brings a calmer, more focused Markdown workspace to Windows, macOS, and Linux.

## Highlights

- Consolidated secondary workspace actions into overflow menus.
- Aligned interface padding, gaps, and margins to an 8-pixel spacing scale.
- Reserved bright accent colors for primary calls to action.
- Reduced card borders and dividers in favor of spacing and subtle surface contrast.
- Added a searchable Help Center with complete workflows, use cases, Hermes/OpenClaw setup, copy-ready AI prompts, troubleshooting, privacy guidance, and licensing.
- Reworked Home around named projects, with direct entry creation, editing, backup-before-delete controls, and no mixed vault-wide entry list.
- Isolated every project graph to that project’s own notes and internal links, with stable project-relative folder clusters and project-relative wikilink resolution so all valid in-project connections are shown.
- Refreshed template guidance and made Today honor the configured daily-notes folder.
- Made starter notes first-use-only so edits and deletions remain exactly as the user leaves them.
- Improved Windows portable startup visibility and Change Vault restart reliability.

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
- [Full changes since 1.5.0](https://github.com/kcmrshll9-ux/Safire/compare/v1.5.0...v${version})
`;

await fs.writeFile(notesPath, notes, 'utf8');
process.stdout.write(`Prepared ${expectedArtifacts.length + 1} release assets for Safire ${version}.\n`);
