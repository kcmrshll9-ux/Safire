# Security policy

Safire reads and writes personal Markdown vaults. Security reports must protect that data while providing enough sanitized information to reproduce the problem.

## Supported versions

Security fixes are applied to the current `main` branch and the current 1.6.x release line. Official Safire 1.6.x Windows, macOS, and Linux downloads are published only through this repository's GitHub Releases page.

Older release lines, source snapshots, and locally built binaries may not receive fixes.

## Report a vulnerability privately

Use **Security → Report a vulnerability** in this GitHub repository when private vulnerability reporting is available.

If that option is unavailable, open an issue titled **Security contact request** with no technical details, logs, screenshots, or reproduction steps. A maintainer will arrange a private channel. Never disclose an unpatched vulnerability in a public issue or discussion.

Include privately:

- the Safire version or commit and run mode;
- the affected feature and likely impact;
- minimal reproduction steps using a temporary vault with invented notes;
- sanitized logs or screenshots, if required; and
- any known workaround.

Do not provide a real vault, private note, backup archive, credential, token, username, or identifying local path.

## Relevant reports

Examples include:

- vault path traversal or unintended access outside the selected vault;
- unintended network access or local API exposure;
- unsafe attachment or rendered-content handling;
- MCP access beyond the selected vault or documented tool surface;
- agent-memory namespace, actor, source, profile, or idempotency isolation failures;
- acceptance of user attribution without successful trusted-bridge authentication;
- backup, restore, or deletion behavior that risks data exposure or loss;
- dependency vulnerabilities with a demonstrated effect on Safire; and
- release-integrity or installer-authenticity concerns.

General defects, feature requests, and setup questions belong in the normal issue tracker after private data is removed.

## Coordinated disclosure

Please allow maintainers time to reproduce, correct, and distribute a fix before sharing technical details publicly. The maintainer will coordinate validation and disclosure with the reporter. Do not test against another person’s vault or system without explicit permission.

## Security boundaries

Safire is local-first, but the Web Clipper performs outbound requests for URLs the user submits, YouTube link cards may load thumbnails, and external links may open in the system browser. See the privacy model in [README.md](README.md) when evaluating a report.

Safire's MCP integrations are separate. The legacy eight-tool server operates on Markdown notes, captures, tasks, and vault health. The additive six-tool agent-memory server writes versioned plaintext JSON beneath the selected vault. Opaque filenames and integrity digests do not encrypt memory content; use operating-system permissions and device encryption where confidentiality matters.

The ordinary memory MCP process receives one fixed, operator-controlled profile. Stable principal, agent-instance, ingest-adapter, source, actor, and namespace identities constrain attribution and access, but profile files are configuration—not reusable authentication credentials. Ordinary portable profiles cannot claim user events. The trusted bridge is an in-process library seam that requires host-supplied authentication before user attribution; it is not a listener, transcript monitor, Hermes modification, or automatic capture service.

Do not submit credentials, tokens, private keys, session cookies, hidden reasoning, chain-of-thought, or scratchpad content as memory. Schema validation rejects common patterns but is not a complete data-loss-prevention system. The detailed memory threat model and operator guidance are in [docs/memory/SECURITY.md](docs/memory/SECURITY.md).
