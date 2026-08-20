# Safire documentation

This directory contains bundled Safire user and agent documentation. Safire is currently version 1.6.2; the searchable in-app Help Center is the complete current software guide, while versioned manuals are retained as clearly labeled historical references. The current application also contains the additive, opt-in general-agent memory foundation.

## Current references

- [Project README](../README.md) — current product status, privacy boundaries, graph behavior, build instructions, and repository policies
- [Changelog](../CHANGELOG.md) — current and historical source milestones
- [Support](../SUPPORT.md) — safe support and bug-reporting workflow
- [Security policy](../SECURITY.md) — private vulnerability-reporting process
- **Safire Help** in the application — complete current workflows, use cases, templates, research and recovery, Hermes/OpenClaw connection steps, AI prompt examples, reference, privacy, troubleshooting, and licenses
- [Agent Instruction Manual](Safire%20Agent%20Instruction%20Manual.md) — MCP operating guidance prepared for the v1.2 tool surface, which remains applicable to the current eight-tool integration
- [Agent Memory](memory/README.md) — current guide for the separate exact six-tool memory MCP, versioned profiles, local sidecar, and invented examples
- [Agent-memory security](memory/SECURITY.md) and [trusted bridge](memory/TRUSTED_BRIDGE.md) — plaintext-storage, trust-boundary, authentication, and no-auto-capture guidance

## Bundled legacy manuals

| Document | Version represented | Status |
| --- | --- | --- |
| [Complete User Guide (HTML)](Safire%20Complete%20User%20Guide%20v1.2.html) | 1.2.0 | Most complete legacy guide; predates the 1.3 graph and evidence changes |
| [Complete User Guide (PDF)](Safire%20Complete%20User%20Guide%20v1.2.pdf) | 1.2.0 | Printable copy of the legacy complete guide |
| [Instruction Manual (HTML)](Safire%20Instruction%20Manual.html) | 1.1.0 | Archived behavior reference |
| [Instruction Manual (PDF)](Safire%20Instruction%20Manual.pdf) | 1.1.0 | Printable archived behavior reference |

## Version note

Where a bundled legacy manual conflicts with the application or the root README, treat the current application and [README.md](../README.md) as authoritative. In particular:

- the current Graph defaults to a deterministic two-dimensional Project map; its optional Full graph shows every matching relationship in mouse-rotatable perspective 3D, and version 1.6.2 restores native full-screen mode for that view in the Windows Electron app;
- source-server vault selection follows the saved desktop selection or `SAFIRE_VAULT_PATH`, not a project-local `./vault` default;
- machine-specific paths in legacy MCP examples must be replaced with paths for the local installation; and
- Safire stores primary data in the selected vault; Web Clipper requests are user-initiated, YouTube cards are local-only until opened, and the desktop content policy blocks remote Markdown images;
- the legacy eight-tool Markdown-vault MCP and additive six-tool agent-memory MCP are separate servers; and
- agent memory is explicit, local plaintext sidecar data—not automatic transcript capture or a modification to Hermes or another host.

Future public releases should keep in-app Help version-matched and archive prior standalone manuals under a dedicated `docs/archive/` directory.
