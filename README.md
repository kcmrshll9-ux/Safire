<p align="center">
  <img src="public/fire-icon.png" width="112" alt="Safire flame logo" />
</p>

<h1 align="center">Safire</h1>

<p align="center">
  A privacy-focused, local-first Markdown knowledge forge for Windows.
</p>

<p align="center">
  <a href="https://github.com/kcmrshll9-ux/Safire/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/kcmrshll9-ux/Safire/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Version 1.3.4" src="https://img.shields.io/badge/version-1.3.4-f97316" />
  <img alt="Windows x64" src="https://img.shields.io/badge/platform-Windows%20x64-2563eb" />
  <img alt="Proprietary source" src="https://img.shields.io/badge/source-proprietary-7c3aed" />
</p>

Safire keeps notes as ordinary Markdown files in a vault you choose. It adds a focused desktop workspace for writing, linking, research capture, graph exploration, tasks, attachments, and recovery without requiring a cloud account.

<p align="center">
  <img src="docs/assets/safire-graph.png" alt="Safire interactive relationship graph" width="100%" />
</p>

<p align="center"><sub>Global graph view using an invented demonstration vault.</sub></p>

## Project status

| Item | Current state |
| --- | --- |
| Current version | 1.3.4 |
| Current source | Release candidate; see the changelog below |
| Desktop target | Windows x64 |
| Storage | Local Markdown vault selected by the user |
| Public installer | Not yet published on GitHub |
| License status | Proprietary; not open source |

Safire is under active development. Version 1.3.4 includes the relationship-first graph and public-release hardening described in the [changelog](CHANGELOG.md#134---2026-08-13). Back up important vaults independently and review the [security policy](SECURITY.md) before using development builds with sensitive material.

## Highlights

- Local filesystem-backed Markdown vault with nested notes and folders
- Split editor and preview, focused edit and reading modes, and tabbed notes
- Search, tags, backlinks, outgoing links, and `[[wiki links]]`
- Interactive 2D force-directed graph with global and local scopes
- Graph depth, filters, folder/tag grouping, display controls, and adjustable forces
- Node hover, drag, pan, zoom, keyboard navigation, context actions, and in-graph note panels
- Daily notes, Markdown tasks, templates, quick capture, and saved searches
- Command palette, quick switcher, and Markdown formatting controls
- Drag-and-drop, paste, and file attachments
- Backup-before-write behavior with preview and restore tools
- Web Clipper and private evidence receipts for local research workflows
- Vault health summaries and configurable local-first settings
- Vault-scoped MCP server with a deliberately narrow tool surface

## Privacy model

Safire is local-first, but “local-first” does not mean the application never uses the network.

- Notes, settings, attachments, and backups are stored in the selected local vault.
- The local HTTP API binds to `127.0.0.1` by default.
- File APIs reject paths outside the selected vault.
- Safire has no built-in cloud synchronization or account service.
- The Web Clipper makes an outbound request only when the user asks it to capture a public URL.
- YouTube link cards may load a thumbnail from `img.youtube.com`.
- Opening an external link hands that URL to the system browser.

The complete data-handling description is in [PRIVACY.md](PRIVACY.md).

Never use a personal vault in automated tests, public bug reports, screenshots, or logs. Use a disposable vault containing invented notes.

## Install on Windows

Safire does not currently publish an installer through GitHub Releases. Do not download executables claiming to be official Safire builds from third-party sites.

An authorized local checkout can build the Windows installer with:

```powershell
npm ci
npm run check
npm run dist:installer
```

The installer is written to:

```text
release/Safire Setup 1.3.4.exe
```

Build the portable executable with `npm run dist:win`. Locally produced builds are not code-signed by default, so Windows SmartScreen may display a warning. The selected vault remains outside the application installation directory and is not packaged into an update.

## Run from source

### Requirements

- Node.js 22.19 or later
- npm
- Windows for Electron packaging and final desktop acceptance checks

Install the locked dependencies, verify the project, and build the application:

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

Start the local server with an ignored, disposable vault:

```powershell
$env:SAFIRE_VAULT_PATH = (Join-Path $PWD ".qa-dev-vault")
npm start
```

Open `http://127.0.0.1:5277`. Use `npm run dev` for the Vite development server or `npm run desktop` for the Electron development application.

## Vault configuration

On first desktop launch, Safire asks the user to choose a vault folder. A typical location is:

```text
Documents/Safire Vault
```

Without `SAFIRE_VAULT_PATH`, the source server follows the saved desktop selection or uses `Documents/Safire Vault`. In the desktop app, use **Safire → Change Vault Location…** to switch later. The desktop application and MCP server share that saved selection.

## Hermes MCP integration

Safire includes a local stdio MCP server so a compatible Hermes setup can work with the selected vault without driving the visual interface. Its tools can list, search, read, create, and update notes; perform quick captures; list and toggle tasks; and report vault health. It does not expose delete, rename, attachment, backup-restore, or web-fetch tools.

Run the MCP server against a one-off test vault with:

```powershell
npm run mcp -- --vault "C:/path/to/Safire Test Vault"
```

A generic stdio configuration looks like:

```yaml
mcp_servers:
  safire:
    command: node
    args:
      - C:/path/to/Safire/safire-mcp.mjs
    timeout: 30
```

Restart the agent session after registering the server or changing the selected vault so its tool connection is refreshed.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Command palette |
| `Ctrl+O` | Quick switcher |
| `Ctrl+S` | Save active note |
| `Esc` | Close the active palette, switcher, or dialog |

## Documentation

See the [documentation index](docs/README.md) for the current documentation status and bundled legacy manuals. Some bundled HTML/PDF guides predate the current graph and evidence features; the application and this README are authoritative where they differ.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/` | React user interface and styles |
| `src/GraphView.tsx` | Interactive 2D relationship graph |
| `server.mjs` | Loopback HTTP API and vault operations |
| `electron/` | Windows desktop application entry point |
| `safire-mcp.mjs` | Vault-scoped MCP server |
| `test/` | Automated tests using disposable data |
| `docs/` | User and agent documentation |
| `press-kit/` | Brand and media materials |

## Support, security, and contributions

- Read [SUPPORT.md](SUPPORT.md) before opening a support request.
- Report suspected vulnerabilities through the private process in [SECURITY.md](SECURITY.md).
- Review [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
- Participation in project spaces is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
- Notable changes are recorded in [CHANGELOG.md](CHANGELOG.md).
- Third-party licenses and distribution obligations are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Source use and copyright

Safire is proprietary software. It is **not open source**. The controlling repository notice is [LICENSE](LICENSE), and brand use is covered by [TRADEMARKS.md](TRADEMARKS.md).

Copyright © 2026 Safire. All rights reserved. Publication of this repository does not grant permission to copy, modify, redistribute, relicense, sell, or incorporate Safire source code or brand assets into another product. Rights provided directly by GitHub’s Terms of Service for viewing and forking on the platform, and rights that cannot lawfully be restricted, are unaffected. Contact the repository owner through GitHub for written permission before any use outside those rights.

Submitting a contribution does not change the license or ownership of the rest of the project. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution terms.
