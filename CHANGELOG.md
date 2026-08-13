# Changelog

Notable changes to Safire are recorded here. Application versions follow the version in `package.json`. This repository does not yet publish tagged GitHub Releases, so the historical entries below describe source milestones rather than downloadable public releases.

## [Unreleased]

## [1.3.4] - 2026-08-13

### Added

- Interactive 2D force-directed relationship graph with global and local scopes.
- Graph depth, search, orphan and unresolved-link filters, folder/tag grouping, display controls, adjustable forces, and modified-time playback.
- Node dragging, hover highlighting, pan and zoom, keyboard navigation, context actions, and graph-preserving note panels.
- Windows CI, dependency update automation, structured issue forms, contribution guidance, support guidance, and private security-reporting instructions.

### Changed

- Replaced the earlier three-dimensional graph workspace with a relationship-first two-dimensional graph designed for both desktop and compact displays.
- Updated repository documentation to distinguish local-first storage from the application’s user-initiated network features.
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
