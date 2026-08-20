# Changelog

Notable changes to Safire are recorded here. Application versions follow the version in `package.json`. Historical entries below describe source milestones and tagged releases.

## [Unreleased]

## [1.6.0] - 2026-08-20

### Added

- Added a searchable in-app Help Center with complete Safire workflows, practical use cases, a copy-ready AI prompt library, verified Hermes and OpenClaw MCP setup, troubleshooting, privacy guidance, the complete MIT License, and bundled third-party software notices.

### Changed

- Consolidated secondary workspace actions into overflow menus so primary tasks remain easy to find.
- Standardized interface padding, gaps, and margins on an 8-pixel spacing scale.
- Reserved bright accent colors for primary calls to action to clarify interaction priority.
- Replaced excess card borders and dividers with spacing and subtle background contrast for a calmer, less boxed-in workspace.
- Consolidated the standalone desktop User Guide into the searchable in-app Safire Help Center.
- Expanded New from template with supported-token guidance and refreshed its Markdown template list whenever the picker opens.
- Made the configured daily-notes folder control where Today creates or opens its note.
- Made the starter `Welcome.md` and `Ideas.md` notes first-vault-only content so user edits and deletions persist across restarts.
- Reworked Home into a project-only index: each top-level user folder is a named project card, while its Markdown entries appear only after opening that project.
- Added project creation, direct entry creation and editing, backup-before-delete controls, and a graph isolated to each project’s own notes and internal links. All Graph actions now open that project-only graph; Safire no longer exposes a mixed vault graph in the interface.
- Organized each project graph into stable project-relative folder clusters, kept nodes inside the visible canvas, and delayed the initial fit until layout settles so the map no longer drifts or clips after opening.
- Made graph link resolution project-relative: bare titles such as `[[Plan]]` and paths such as `[[Notes/Decision]]` resolve inside the opened project even when another project contains entries with the same names.
- Improved Windows portable startup visibility and made Change Vault relaunch the outer portable application instead of its temporary extracted runtime.
- Replaced project-specific memory documentation and fixtures with neutral synthetic agent and automation examples.
- Updated Safire and both MCP server versions to 1.6.0.

## [1.5.0] - 2026-08-16

### Added

- Added native macOS disk images for Apple Silicon and Intel Macs.
- Added Linux x64 AppImage and Debian packages.
- Added a platform-native shell launcher for the optional packaged memory MCP runtime on macOS and Linux.
- Added native CI packaging and packaged-runtime security checks for Windows x64, Linux x64, macOS Apple Silicon, and macOS Intel.
- Added a tag-triggered release workflow that publishes verified multi-platform assets and a complete SHA-256 manifest.

### Changed

- Updated desktop, support, contribution, issue-reporting, and release documentation for the three supported operating systems.
- Updated Safire and both MCP server versions to 1.5.0.
- Disabled electron-builder's implicit CI publishing so verified artifacts are uploaded only by the checksum-gated release job, and normalized Linux package filenames to `x64`.

### Security

- Strengthened cross-platform filesystem identity checks with file birth time so immediate POSIX inode reuse cannot make a replacement look like the previously opened path.

### Known limitations

- Windows and macOS packages are not code-signed. Windows SmartScreen or macOS Gatekeeper may display a warning.

## [1.4.2] - 2026-08-16

### Changed

- Relicensed Safire under the MIT License and aligned package metadata, contribution terms, public documentation, and press materials.
- Standardized Windows release asset filenames for reliable direct downloads and checksum verification.

## [1.4.1] - 2026-08-16

### Security

- Hardened memory credential detection for underscore- and hyphen-delimited credential-like values, embedded compact JWTs, JWT punctuation boundaries, and bounded adversarial scan work.
- Added regression coverage for credential/JWT boundary handling in the memory schema and MCP ingress.

## [1.4.0] - 2026-08-14

### Added

- Added an opt-in, versioned general-agent memory sidecar that stores attributed events, append-only feedback, provenance, namespace grants, stable identities, idempotency markers, and recovery journals as local plaintext JSON beneath the selected vault.
- Added a separate `safire-memory-mcp.mjs` entry point with exactly six tools: `memory_record_events`, `memory_search`, `memory_get`, `memory_record_feedback`, `memory_recall`, and `memory_status`. The existing `safire-mcp.mjs` Markdown-vault integration remains a separate eight-tool server.
- Windows installer output exposes an opt-in `resources/safire-memory-mcp.cmd` launcher with the required runtime files unpacked, so an external MCP host can use installed Safire without a separate Node.js checkout. Registration remains manual; the portable EXE has no stable external launcher path.
- Added a trusted-bridge library contract for host-authenticated user events. It is an explicit in-process seam and simulator, not a listener, transcript monitor, automatic capture service, or Hermes modification.
- Added agent-memory architecture, security, operator, and example documentation using neutral synthetic agent and delegated-automation identities; the subsystem is agent-general.

### Security

- Fixed profiles now bind stable principal, agent-instance, ingest-adapter, source, actor, and namespace identities. Ordinary portable MCP profiles cannot claim user activity, while trusted user events require host authentication and explicit trusted-bridge configuration.
- Agent-memory records remain local plaintext. Opaque filenames and integrity digests are not encryption, and schema filtering of credentials or private reasoning is defense in depth rather than a complete data-loss-prevention system.

### Not included

- Safire 1.4.0 does not include automatic Hermes capture or any other installed agent-host capture integration.
- AWS archival, fading, compression, memory encryption, reactivation, automatic local eviction, archival lifecycle automation, and permanent memory deletion are not part of Safire 1.4.0.

## [1.3.4] - 2026-08-13

### Added

- Interactive 2D force-directed relationship graph with global and local scopes.
- Graph depth, search, orphan and unresolved-link filters, folder/tag grouping, display controls, adjustable forces, and modified-time playback.
- Node dragging, hover highlighting, pan and zoom, keyboard navigation, context actions, and graph-preserving note panels.
- Windows CI, dependency update automation, structured issue forms, contribution guidance, support guidance, and private security-reporting instructions.

### Changed

- Replaced the earlier three-dimensional graph workspace with a relationship-first two-dimensional graph designed for both desktop and compact displays.
- Updated repository documentation to distinguish local vault storage from the application’s user-initiated network features.
- Replaced machine-specific development examples with generic, disposable-vault examples.
- Hardened loopback API request validation, private-data cache controls, client error redaction, attachment previews, and packaged Electron permissions.
- Added proprietary, privacy, trademark, third-party, security, support, and contribution notices for a reviewed public-facing repository snapshot.

### Fixed

- Graph links now resolve normalized note paths deterministically and leave ambiguous duplicate titles unresolved.
- Graph, backlink, and vault-health calculations now use the same link-resolution rules.
- Fenced code and private evidence data are excluded from graph relationship extraction.

## [1.3.3] - 2026-07-27

### Added

- Private local evidence receipts for captured research.

### Changed

- Notes opened from the graph remain inside the full-screen graph workspace for preview and editing.

## [1.3.1] - 2026-07-26

### Changed

- Improved graph navigation and layout behavior for larger vaults.

## [1.3.0] - 2026-07-20

### Added

- Initial graph workspace for exploring note relationships.

## [1.2.0] - 2026-07-19

### Added

- Vault-scoped MCP integration for note, capture, task, and vault-health workflows.
- Shared desktop and MCP vault selection.
- Additional local path and loopback-service hardening.

## [1.1.0] - 2026-07-06

### Added

- Markdown formatting controls, attachment workflows, backup preview and restore, daily notes, backlinks, tags, and the initial Safire desktop documentation set.
