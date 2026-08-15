# Safire privacy notice

Last updated: August 14, 2026

This notice describes the Safire application contained in this repository. It
does not govern GitHub, an operating system, an MCP host, a web page opened or
clipped by the user, a storage or synchronization provider, or other
third-party software or services.

## Local storage and processing

Safire is designed to keep its working data on the user's device. It does not
require a Safire account. The current application does not include an
application analytics, advertising, or telemetry service.

Safire stores and processes the following locally:

- Markdown notes, attachments, captured web pages, evidence receipts, and
  backup copies in the vault folder selected by the user.
- Settings, pinned and recent note paths, saved searches, and custom web-clip
  templates in the vault's `.safire` folder.
- When the separate agent-memory integration is enabled and explicitly used,
  attributed events, feedback, provenance, namespace metadata, and recovery
  state as plaintext JSON under `<vault>/.safire/memory/v1/`.
- The selected vault path in a local configuration file. On a standard Windows
  installation this is under `AppData/Local/Safire/vault.json`.
- Open tabs, view choices, autosave state, and graph preferences in application
  browser storage.
- A small offline application-shell cache created by the service worker. API
  responses containing vault data are excluded from that cache.

Safire reads vault files locally to provide editing, search, backlinks, tags,
tasks, graph relationships, evidence features, backups, and vault-health
information.

Private `private_notes` and legacy `notes` evidence fields remain in the local
Markdown and in explicit note or evidence reads, but are excluded fail-closed
from generic note metadata, search, graph, and MCP list/search projections.
Malformed or unclosed evidence blocks contribute no generic metadata.

The agent-memory sidecar records only explicit MCP calls or deliberate host
library calls. It does not monitor conversations, modify Hermes or another
agent host, or automatically capture transcripts. The trusted-bridge library
records nothing unless host code creates a paired bridge with an authenticator
and explicitly invokes `bridge.ingest` or `bridge.ingestFeedback`; privileged
recording callbacks remain private to that pair.

## Local server

The desktop application uses an HTTP service bound to a loopback address. It
is intended for communication on the same device and is not bound to the local
network or public internet. Loopback is not an authentication boundary: other
software running under the same device or user context may be able to contact
the desktop service while it is running. The legacy eight-tool vault MCP uses
stdio and an in-process vault service, so it does not open an HTTP listener.
The separate six-tool agent-memory MCP also uses stdio and local vault files;
it does not add a network listener.

## When data leaves the device

Safire makes an external request only when a feature requires one or the user
directs one, including these cases:

- **Web clipper.** Safire requests the public HTTP or HTTPS URL entered by the
  user and saves extracted content to the local vault. The destination site
  and its hosting providers may receive the device's network address, the
  requested URL, timing information, and Safire's web-clipper user agent. DNS
  services may receive the destination hostname and related timing information.
  Safire blocks requests to detected local and private-network targets.
- **YouTube links.** Rendering a recognized YouTube link creates a local-only
  card without downloading a thumbnail or embedding a player. YouTube is
  contacted only after the user opens that link in the system browser.
- **Remote Markdown images.** The desktop content policy blocks HTTP and HTTPS
  image subresources. Attach images to the local vault when they should render
  in Preview without contacting an external image host.
- **External links.** HTTP, HTTPS, and email links opened from the desktop app
  are handed to the system's external browser or mail application. Their data
  practices apply after the link is opened.
- **MCP integrations.** If a user connects either Safire MCP server to a host,
  that host can invoke its exposed tools. The legacy server has eight tools for
  Markdown notes, captures, tasks, and vault health. The separate memory server
  has six tools for recording, searching, retrieving, recalling, and appending
  feedback to attributed memory. Information returned through either MCP
  connection is delivered to that host and may then be processed under the
  host's own settings and privacy terms. Users should enable an integration
  only for hosts they trust and review each host's data controls.

Safire does not send an entire vault to a clipping target merely by running
the application. Content can nevertheless leave the device when the
user copies it, stores the vault in a synchronized folder, opens it with other
software, or authorizes an integration to access it.

## User control, retention, and deletion

Vault data consists of ordinary files in the selected folder. Users can view,
copy, move, back up, encrypt, or remove those files with their normal operating
system tools. Safire may create a backup before a note is overwritten,
restored, task-edited, or deleted. Renaming a note does not itself create a
backup. Deleting a note therefore may not
delete its backup copies; backups in `.safire-backups` must be reviewed and
removed separately when they are no longer wanted.

Agent-memory filenames are opaque, but the JSON records themselves are not
encrypted. Stable actor, source, profile, and vault identities support
attribution and idempotency; they are not credentials or encryption keys.

Removing the vault does not necessarily remove the local vault-path setting,
application browser preferences, offline application-shell cache, operating
system backups, synchronized copies, or data already disclosed to an external
service or MCP host. Those locations must be handled separately.

## Security and user responsibility

Safire uses local files and restricts its application server to loopback, but
no software can promise absolute security or non-disclosure. Device accounts,
file permissions, disk encryption, malware protection, physical access,
backups, and synchronization settings affect the confidentiality of a vault.
Users should avoid putting secrets in a vault or integration they do not
adequately control.

## Changes and questions

This notice should be updated when Safire's data handling materially changes.
Questions may be raised through the repository's published issue tracker, but
private note content, credentials, and other sensitive information should not
be posted in a public issue.
