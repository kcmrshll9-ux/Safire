# Safire privacy notice

Last updated: August 13, 2026

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
- The selected vault path in a local configuration file. On a standard Windows
  installation this is under `AppData/Local/Safire/vault.json`.
- Open tabs, view choices, autosave state, and graph preferences in application
  browser storage.
- A small offline application-shell cache created by the service worker. API
  responses containing vault data are excluded from that cache.

Safire reads vault files locally to provide editing, search, backlinks, tags,
tasks, graph relationships, evidence features, backups, and vault-health
information.

## Local server

The desktop application and optional MCP integration start an HTTP service
bound to a loopback address. It is intended for communication on the same
device and is not bound to the local network or public internet. Loopback is
not an authentication boundary: other software running under the same device
or user context may be able to contact the service while it is running.

## When data leaves the device

Safire makes an external request only when a feature requires one or the user
directs one, including these cases:

- **Web clipper.** Safire requests the public HTTP or HTTPS URL entered by the
  user and saves extracted content to the local vault. The destination site
  and its hosting providers may receive the device's network address, the
  requested URL, timing information, and Safire's web-clipper user agent. DNS
  services may receive the destination hostname and related timing information.
  Safire blocks requests to detected local and private-network targets.
- **YouTube previews.** Rendering a note containing a recognized YouTube link
  may request a thumbnail from `img.youtube.com`. That service receives the
  normal information associated with an image request, including the device's
  network address and the video identifier in the URL. Safire sets a
  `no-referrer` policy.
- **External links.** HTTP, HTTPS, and email links opened from the desktop app
  are handed to the system's external browser or mail application. Their data
  practices apply after the link is opened.
- **MCP integration.** If a user connects Safire to an MCP host, that host can
  invoke the exposed Safire tools to read, search, create, or change vault data.
  Information returned through MCP is delivered to that host over the MCP
  connection and may then be processed under the host's own settings and
  privacy terms. Users should enable this integration only for hosts they
  trust and review each host's data controls.

Safire does not send an entire vault to a clipping target or YouTube merely by
running the application. Content can nevertheless leave the device when the
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
