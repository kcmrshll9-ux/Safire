# Working product upgrade

Base: Safire 1.6.2 (`6c1c7ab`). This work improves the existing local desktop product.

## Acceptance criteria

- Drafts survive navigation, tab closing, reload, and desktop restarts. Save acknowledgements cannot corrupt another note's state.
- Reads carry content revisions. Conditional writes check revisions under the vault mutation lock. Conflicts keep both versions available.
- Rename previews identify affected wikilinks, preserve aliases/headings and code, and back up changed notes.
- A rebuildable local catalog supports paged discovery and full-vault search beyond the legacy 1,000-note projection limit. Resource limits and incomplete indexing remain explicit.
- Writing, projects, capture, evidence review, and portable report export form a coherent, accessible workspace.
- Existing tests, focused regression tests, TypeScript, production build, real browser workflows, and Windows packaging are verified using invented notes.

Commercial infrastructure, team hosting, and paid certificates are not prerequisites for this local product upgrade.

## Try it

On Windows, launch `release/Safire-Working-Preview.exe`. The portable build uses Safire's existing vault selection, or asks you to choose a vault on first launch. It is an unsigned development preview, retains the base application version 1.6.2, and has not been published as a GitHub release.

For source development, use Node 22.19 or newer, `npm ci`, then `npm run build` and `npm start`. Set `SAFIRE_VAULT_PATH` to a disposable vault for testing. `npm run desktop` opens the Electron application after its dependencies and frontend have been built.

## What changed

The home workspace brings recent notes, capture, projects, and research into one starting point. Light mode uses warm paper and forest green; dark mode uses charcoal and warm gold. Focus mode gives the editor more space without changing the note's contents.

Drafts are protected separately from saving. Checkpoints live beneath `.safire/drafts`, survive a change in the desktop server's port, and are recoverable from Home. Save responses are tied to the note and content snapshot that initiated them. If another writer changed the file, Safire shows a conflict with comparison, a separate-copy action, and an explicit way to base a reviewed merge on the latest version. Native close and vault switching wait for checkpoints. A single desktop instance per profile prevents accidental duplicate launches.

Rename previews count resolved wikilinks before changing files. The operation checks revisions under the vault mutation lock, backs up originals, preserves aliases and headings, updates outgoing relative links when moving a note, and attempts rollback after an error. Independently edited files are preserved during rollback. Immutable backups remain available if rollback cannot safely restore a file.

The research desk groups evidence notes, filters claims by recorded status and date, and creates Markdown or designed HTML briefs. Reports include selected note excerpts, public claims, author-recorded assessments, and HTTP(S) source URLs. They exclude private receipt fields and local source fields. The downloaded HTML is self-contained and printable. Ordinary prose and the user's summary are included, so review them before sharing.

The new library has a persistent SQLite catalog with incremental scans, pagination, a damaged-cache fallback, and explicit completeness notices. The file tree renders large folders in batches. Search reaches notes beyond the legacy 1,000-note discovery ceiling. Markdown import copies selected files into `Imports/` and skips collisions.

## Verification

- Clean install from `package-lock.json`; TypeScript and production build pass.
- Full suite: 455 passing tests, including the two packaged memory-launcher checks; zero skips and zero failures.
- Ten new backend regressions cover concurrent saves, draft cleanup, 1,025-note discovery, private-field exclusion, damaged catalogs, combined evidence filters, outgoing links, stale rename plans, backups, and rollback with external edits.
- The packaged Windows gate verifies Markdown sanitization, draft navigation and reload recovery, conflicting external writes, recovery copies, typing while a save response is delayed, and the desktop checkpoint handshake. These checks use invented notes in an isolated profile.
- Browser checks cover recovery across server restarts, the research board, source URLs, designed report export, keyboard dialog dismissal, and the visual workspace.
- The portable executable's archive passes its integrity check, and its application payload matches the unpacked application used by the Windows gates. A SHA-256 checksum is provided beside the executable.

## Current boundaries

- This remains a local, single-user Markdown application. Cloud synchronization, team collaboration, and signed distribution are separate work.
- Draft checkpoints support up to 1 MB of Markdown and keep one current draft per note. They are plaintext, not an encrypted backup or a simultaneous multi-client editing protocol. If recovery fails, the UI reports it and explicit Save remains available.
- The catalog supports 100,000 notes, 250,000 directory entries, depth 64, and a 256 MiB body-read budget per refresh, with 1 MiB per note. The sidebar/project browser loads up to 10,000 notes. Search pages cover the full catalog. Legacy graphs, tasks, health, backlinks, and MCP list/search retain their existing bounded projections.
- Catalog refresh is on demand with a short cache interval. Use **Refresh library** after external changes. If the disk catalog is damaged, search rebuilds in memory for that session; the original Markdown remains authoritative.
- Renaming updates resolvable wikilinks, not ordinary Markdown links or attachment references. Ambiguous links remain unchanged. A complete rename review requires readable note bodies within a 64 MiB review budget. Multi-file changes have backups and rollback, but are not a crash-atomic filesystem transaction.
- Desktop and browser saves supply content revisions. The HTTP and MCP update APIs accept optional revisions for compatibility; external clients must pass the revision from their read to receive conflict protection.
- Windows x64 is packaged and tested locally. macOS and Linux require their native CI/build environments before release.
