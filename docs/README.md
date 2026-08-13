# Safire documentation

This directory contains bundled Safire user and agent documentation. Safire is currently version 1.3.4; the unversioned visual guide covers current core workflows, while the versioned manuals are retained as clearly labeled historical references.

## Current references

- [Project README](../README.md) — current product status, privacy boundaries, graph behavior, build instructions, and repository policies
- [Changelog](../CHANGELOG.md) — current and historical source milestones
- [Support](../SUPPORT.md) — safe support and bug-reporting workflow
- [Security policy](../SECURITY.md) — private vulnerability-reporting process
- [Safire User Guide](Safire%20User%20Guide.html) — current visual overview for Safire 1.3.4 and the guide opened from the desktop Help menu
- [Agent Instruction Manual](Safire%20Agent%20Instruction%20Manual.md) — MCP operating guidance prepared for the v1.2 tool surface, which remains applicable to the current eight-tool integration

## Bundled legacy manuals

| Document | Version represented | Status |
| --- | --- | --- |
| [Complete User Guide (HTML)](Safire%20Complete%20User%20Guide%20v1.2.html) | 1.2.0 | Most complete legacy guide; predates the 1.3 graph and evidence changes |
| [Complete User Guide (PDF)](Safire%20Complete%20User%20Guide%20v1.2.pdf) | 1.2.0 | Printable copy of the legacy complete guide |
| [Instruction Manual (HTML)](Safire%20Instruction%20Manual.html) | 1.1.0 | Archived behavior reference |
| [Instruction Manual (PDF)](Safire%20Instruction%20Manual.pdf) | 1.1.0 | Printable archived behavior reference |

## Version note

Where a bundled legacy manual conflicts with the application or the root README, treat the current application and [README.md](../README.md) as authoritative. In particular:

- the current Graph is a two-dimensional force-directed relationship graph, not the earlier three-dimensional workspace;
- source-server vault selection follows the saved desktop selection or `SAFIRE_VAULT_PATH`, not a project-local `./vault` default;
- machine-specific paths in legacy MCP examples must be replaced with paths for the local installation; and
- Safire is local-first but can make user-initiated Web Clipper requests and load external YouTube thumbnails.

Future public releases should publish one version-matched user guide and archive prior manuals under a dedicated `docs/archive/` directory.
