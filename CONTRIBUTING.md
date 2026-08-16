# Contributing to Safire

Thank you for your interest in improving Safire. Safire is open-source software distributed under the [MIT License](LICENSE). Public issue reports, feature proposals, documentation improvements, and code contributions are welcome.

The software license does not grant rights to use the Safire name or marks in a way that suggests endorsement or affiliation. See [TRADEMARKS.md](TRADEMARKS.md).

## Before you begin

- Discuss substantial behavior, architecture, or interface changes in an issue before implementation.
- Keep each pull request focused on one problem.
- Use a temporary vault containing only synthetic notes for development and testing.
- Report potential vulnerabilities through [SECURITY.md](SECURITY.md), not through a public issue.
- Do not submit third-party code, media, or text unless you have the rights required for Safire to use it.

## Development setup

Safire requires Node.js 22.19 or later and npm. Native Windows, macOS, and Linux runners validate their corresponding desktop artifacts.

```powershell
npm ci
npm run build
$env:SAFIRE_VAULT_PATH = (Join-Path $PWD ".qa-dev-vault")
npm start
```

Open `http://127.0.0.1:5277`. The `.qa-dev-vault` directory is ignored by Git and keeps development activity away from a saved personal vault.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the Vite development server |
| `npm run desktop` | Start the Electron development application |
| `npm test` | Run the Node.js test suite |
| `npm run typecheck` | Check TypeScript without emitting files |
| `npm run build` | Produce the web application bundle |
| `npm run check` | Run type checks, tests, and the production build |
| `npm run dist:installer` | Build the local Windows installer |
| `npm run dist:win` | Build the local portable executable |
| `npm run dist:mac` | Build macOS Intel and Apple Silicon disk images on macOS |
| `npm run dist:linux` | Build Linux x64 AppImage and Debian packages on Linux |

## Making a change

1. Create a focused branch such as `fix/backup-retention` or `docs/setup-guide`.
2. Make the smallest coherent change that solves the issue.
3. Add or update tests for observable behavior.
4. Run the required checks.
5. Update README, user documentation, or the changelog when behavior changes.
6. Open a pull request and complete its validation and privacy checklists.

Use clear, imperative commit messages. Prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:` are welcome.

## Required checks

Before requesting review, run:

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

For desktop-shell, installer, file-path, attachment, or launcher changes, also perform the relevant native-platform acceptance checks. Pull requests run packaged runtime checks on Windows x64, Linux x64, macOS Intel, and macOS Apple Silicon.

## Data-safety expectations

- Never commit a vault, note, backup, environment file, token, credential, or identifying local path.
- Avoid logs and screenshots that reveal note content or usernames.
- Keep the HTTP service bound to loopback unless a separately reviewed design requires otherwise.
- Reject filesystem access outside the selected vault.
- Preserve backup-before-write behavior around destructive or replacement operations.
- Keep fixtures disposable, minimal, and clearly synthetic.

## Contribution terms

You must own the contribution or have authority to submit it. By submitting a pull request, you agree that your contribution is licensed under the project's [MIT License](LICENSE).

All contributions are subject to review and may be declined or rewritten to preserve the project's product direction, quality, privacy, and security model.
