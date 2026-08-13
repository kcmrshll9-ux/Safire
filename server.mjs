import express from 'express';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import vaultConfig from './vault-config.cjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { resolveVaultPath: resolveConfiguredVaultPath } = vaultConfig;
const LOOPBACK_HOST = '127.0.0.1';
function loopbackHost(candidate) {
  return ['127.0.0.1', '::1'].includes(String(candidate || '').trim()) ? String(candidate).trim() : LOOPBACK_HOST;
}

function loopbackAuthority(rawAuthority = '') {
  const authority = String(rawAuthority).trim().toLowerCase();
  const ipv6 = authority.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  const regular = authority.match(/^([^:]+)(?::(\d{1,5}))?$/);
  const hostname = ipv6?.[1] || regular?.[1] || '';
  const portText = ipv6?.[2] || regular?.[2] || '';
  const port = portText ? Number(portText) : 80;
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname, port };
}

function requestOriginAllowed(originHeader, hostAuthority) {
  if (!originHeader) return true;
  try {
    const origin = new URL(String(originHeader));
    if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    const parsedOrigin = loopbackAuthority(origin.host);
    return Boolean(parsedOrigin && parsedOrigin.hostname === hostAuthority.hostname && parsedOrigin.port === hostAuthority.port);
  } catch {
    return false;
  }
}

function fetchMetadataAllowed(value = '') {
  const site = String(value).trim().toLowerCase();
  return !site || site === 'same-origin' || site === 'none';
}

const HOST = loopbackHost(process.env.HOST);
const PORT = Number(process.env.PORT || 5277);
const DEFAULT_DIST_DIR = path.join(__dirname, 'dist');
let VAULT_DIR = resolveConfiguredVaultPath();
let DIST_DIR = DEFAULT_DIST_DIR;
const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === __filename;

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const embeddedAttachment = req.path === '/api/attachment' && req.query.raw === '1';
  const frameAncestors = embeddedAttachment ? "'self'" : "'none'";
  res.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-ancestors ${frameAncestors}; img-src 'self' https://img.youtube.com; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'`);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', embeddedAttachment ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  const requestHost = loopbackAuthority(req.get('host'));
  if (!requestHost) return res.status(403).json({ error: 'Request rejected' });

  if (req.path === '/api' || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (!requestOriginAllowed(req.get('origin'), requestHost) || !fetchMetadataAllowed(req.get('sec-fetch-site'))) {
      return res.status(403).json({ error: 'Request rejected' });
    }
  }
  next();
});
app.use(express.json({ limit: '10mb' }));

async function ensureVault() {
  await fs.mkdir(VAULT_DIR, { recursive: true });
  await fs.mkdir(path.join(VAULT_DIR, 'Daily Notes'), { recursive: true });
  const welcome = path.join(VAULT_DIR, 'Welcome.md');
  if (!fssync.existsSync(welcome)) {
    await fs.writeFile(welcome, `# Welcome to Safire\n\nSafire is your privacy-focused, local-first Markdown workspace: warm, fast, portable, and yours.\n\n- Link notes with [[Ideas]]\n- Tag notes with #home or #projects\n- Use the graph view to see connections\n- Press Ctrl+K for the command palette\n- Press Ctrl+O for quick switcher\n- Press Ctrl+S to save\n\nCore note workflows stay on this computer. See PRIVACY.md for the network boundaries of optional features.\n`, 'utf8');
  }
  const ideas = path.join(VAULT_DIR, 'Ideas.md');
  if (!fssync.existsSync(ideas)) {
    await fs.writeFile(ideas, `# Ideas\n\nThis note links back to [[Welcome]].\n\n#ideas\n`, 'utf8');
  }
}

function slash(p) { return String(p).replace(/\\/g, '/'); }
function titleFromPath(rel) { return path.basename(rel, '.md'); }
function safeFilename(raw) { return String(raw).replace(/[<>:"|?*]/g, '-').replace(/\s+/g, ' ').trim(); }

function normalizeFolderPath(raw = '') {
  let p = slash(raw).replace(/^\/+|\/+$/g, '').trim();
  if (!p) return '';
  if (p.includes('\0') || p.split('/').some(part => part === '..' || part === '')) throw new Error('Unsafe folder path');
  return p;
}

function normalizeNotePath(raw = '') {
  let p = slash(raw).replace(/^\/+/, '').trim();
  if (!p) throw new Error('Missing note path');
  if (!p.toLowerCase().endsWith('.md')) p += '.md';
  if (p.includes('\0') || p.split('/').some(part => part === '..' || part === '')) throw new Error('Unsafe note path');
  return p;
}

function assertNoReparsePoints(abs, root = VAULT_DIR) {
  const relative = path.relative(root, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes vault');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fssync.lstatSync(current).isSymbolicLink()) throw new Error('Vault paths cannot use symlinks or junctions');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function resolveVaultPath(rel = '') {
  const normalized = normalizeFolderPath(rel);
  const abs = path.resolve(VAULT_DIR, normalized);
  if (!abs.startsWith(VAULT_DIR + path.sep) && abs !== VAULT_DIR) throw new Error('Path escapes vault');
  assertNoReparsePoints(abs);
  return { rel: normalized, abs };
}

function resolveNotePath(raw) {
  const rel = normalizeNotePath(raw);
  const abs = path.resolve(VAULT_DIR, rel);
  if (!abs.startsWith(VAULT_DIR + path.sep) && abs !== VAULT_DIR) throw new Error('Path escapes vault');
  assertNoReparsePoints(abs);
  return { rel, abs };
}

async function walkMarkdown(dir, base = dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...await walkMarkdown(full, base));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(slash(path.relative(base, full)));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function buildTree(dir = VAULT_DIR, base = VAULT_DIR) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = slash(path.relative(base, full));
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      children.push({ type: 'folder', name: entry.name, path: rel, children: await buildTree(full, base) });
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      children.push({ type: 'note', name: entry.name, path: rel, title: titleFromPath(rel) });
    }
  }
  return children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
}

function parseLinks(content) {
  const links = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(content))) links.push(m[1].trim());
  return [...new Set(links)].filter(Boolean);
}

function parseTags(content) {
  const tags = [];
  const re = /(^|\s)#([A-Za-z0-9_/-]+)/g;
  let m;
  while ((m = re.exec(content))) tags.push(m[2]);
  return [...new Set(tags)].sort();
}

function stripPrivateEvidenceFields(content = '') {
  return String(content).replace(/^\s*```safire-evidence\s*\x0d?\n([\s\S]*?)^\s*```\s*$/gim, (block, body) => {
    const visible = body.split('\n').filter(line => !/^\s*(?:private_notes|notes)\s*:/i.test(line)).join('\n');
    return block.replace(body, visible);
  });
}

function semanticMarkdownContent(content = '') {
  const lines = stripPrivateEvidenceFields(content).split(/\r?\n/);
  const visible = [];
  let fenceCharacter = '';
  let fenceLength = 0;
  for (const line of lines) {
    if (!fenceCharacter) {
      const opening = line.match(/^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})/);
      if (opening) {
        fenceCharacter = opening[1][0];
        fenceLength = opening[1].length;
        continue;
      }
      visible.push(line.replace(/`[^`\r\n]*`/g, ''));
      continue;
    }
    const closing = line.match(/^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`+|~+)[ \t]*$/);
    if (closing && closing[1][0] === fenceCharacter && closing[1].length >= fenceLength) {
      fenceCharacter = '';
      fenceLength = 0;
    }
  }
  return visible.join('\n');
}

function excerpt(content) {
  return content.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`\[\]()!-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function noteMeta(rel) {
  const { abs } = resolveNotePath(rel);
  const [stat, content] = await Promise.all([fs.stat(abs), fs.readFile(abs, 'utf8')]);
  return { path: rel, title: titleFromPath(rel), folder: slash(path.dirname(rel)) === '.' ? '' : slash(path.dirname(rel)), size: stat.size, mtime: stat.mtimeMs, tags: parseTags(content), links: parseLinks(content), excerpt: excerpt(content) };
}

async function allNotesWithContent() {
  const rels = await walkMarkdown(VAULT_DIR);
  const notes = [];
  for (const rel of rels) {
    const { abs } = resolveNotePath(rel);
    const [stat, content] = await Promise.all([fs.stat(abs), fs.readFile(abs, 'utf8')]);
    const semanticContent = semanticMarkdownContent(content);
    notes.push({
      rel,
      content,
      title: titleFromPath(rel),
      folder: slash(path.dirname(rel)) === '.' ? '' : slash(path.dirname(rel)),
      size: stat.size,
      mtime: stat.mtimeMs,
      tags: parseTags(semanticContent),
      links: parseLinks(semanticContent),
    });
  }
  return notes;
}

function wikiLinkPath(rawTarget = '') {
  let target = slash(rawTarget).trim().replace(/^\/+/, '').replace(/^(?:\.\/)+/, '');
  if (!target || target.includes('\0')) return '';
  const parts = target.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return '';
  if (!/\.md$/i.test(target)) target += '.md';
  return target;
}

function addWikiLinkIndexValue(index, key, value) {
  const values = index.get(key) || [];
  values.push(value);
  index.set(key, values);
}

function createWikiLinkResolver(notes) {
  const paths = new Map();
  const titles = new Map();
  for (const note of notes) {
    addWikiLinkIndexValue(paths, note.rel.toLowerCase(), note.rel);
    const basename = path.posix.basename(note.rel).replace(/\.md$/i, '').toLowerCase();
    addWikiLinkIndexValue(titles, basename, note.rel);
  }
  return rawTarget => {
    const normalizedPath = wikiLinkPath(rawTarget);
    const fallbackTarget = normalizedPath || wikiLinkPath(String(rawTarget).replace(/\.\./g, '')) || `${String(rawTarget).trim() || 'Untitled'}.md`;
    if (!normalizedPath) return { target: fallbackTarget, resolved: false, resolution: 'missing' };
    const exactMatches = paths.get(normalizedPath.toLowerCase()) || [];
    if (exactMatches.length === 1) return { target: exactMatches[0], resolved: true, resolution: 'exact-path' };
    if (exactMatches.length > 1) return { target: normalizedPath, resolved: false, resolution: 'ambiguous' };
    if (!normalizedPath.includes('/')) {
      const basename = path.posix.basename(normalizedPath).replace(/\.md$/i, '').toLowerCase();
      const titleMatches = titles.get(basename) || [];
      if (titleMatches.length === 1) return { target: titleMatches[0], resolved: true, resolution: 'unique-title' };
      if (titleMatches.length > 1) return { target: normalizedPath, resolved: false, resolution: 'ambiguous' };
    }
    return { target: normalizedPath, resolved: false, resolution: 'missing' };
  };
}

async function backupIfExists(abs) {
  if (!fssync.existsSync(abs)) return null;
  const rel = slash(path.relative(VAULT_DIR, abs));
  const backupDir = resolveVaultPath(`.safire-backups/${new Date().toISOString().slice(0, 10)}`).abs;
  await fs.mkdir(backupDir, { recursive: true });
  const backupName = rel.replace(/[\\/:]/g, '__') + '.' + Date.now() + '.bak';
  const backupPath = path.join(backupDir, backupName);
  await fs.copyFile(abs, backupPath);
  return slash(path.relative(VAULT_DIR, backupPath));
}

function settingsDir() { return resolveVaultPath('.safire').abs; }
function settingsPath() { return path.join(settingsDir(), 'settings.json'); }
const DEFAULT_SETTINGS = {
  autosave: true,
  autosaveDelay: 900,
  defaultMode: 'split',
  startupNote: 'Welcome.md',
  dailyNotesFolder: 'Daily Notes',
  backupRetentionDays: 30,
  confirmDeletes: true,
  theme: 'dark',
  fitImagesToPage: true
};

async function readSettings() {
  await fs.mkdir(settingsDir(), { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    if (!['dark', 'light'].includes(merged.theme)) merged.theme = 'dark';
    return merged;
  } catch {
    await fs.writeFile(settingsPath(), JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(patch = {}) {
  const current = await readSettings();
  const next = { ...current };
  if (typeof patch.autosave === 'boolean') next.autosave = patch.autosave;
  if (Number.isFinite(Number(patch.autosaveDelay))) next.autosaveDelay = Math.min(10000, Math.max(250, Number(patch.autosaveDelay)));
  if (['split', 'edit', 'preview', 'graph'].includes(patch.defaultMode)) next.defaultMode = patch.defaultMode;
  if (typeof patch.startupNote === 'string' && patch.startupNote.trim()) next.startupNote = normalizeNotePath(patch.startupNote);
  if (typeof patch.dailyNotesFolder === 'string' && patch.dailyNotesFolder.trim()) next.dailyNotesFolder = normalizeFolderPath(patch.dailyNotesFolder) || 'Daily Notes';
  if (Number.isFinite(Number(patch.backupRetentionDays))) next.backupRetentionDays = Math.min(365, Math.max(1, Number(patch.backupRetentionDays)));
  if (typeof patch.confirmDeletes === 'boolean') next.confirmDeletes = patch.confirmDeletes;
  if (typeof patch.theme === 'string' && ['dark', 'light'].includes(patch.theme.trim())) next.theme = patch.theme.trim();
  if (typeof patch.fitImagesToPage === 'boolean') next.fitImagesToPage = patch.fitImagesToPage;
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

async function walkAllFiles(dir, base = dir) {
  if (!fssync.existsSync(dir)) return [];
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...await walkAllFiles(full, base));
    else if (entry.isFile()) out.push(slash(path.relative(base, full)));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function backupNoteFromName(fileRel) {
  const base = path.basename(fileRel).replace(/\.bak$/i, '');
  const withoutStamp = base.replace(/\.\d+$/, '');
  return withoutStamp.replace(/__/g, '/');
}

function resolveBackupId(id = '') {
  const rel = slash(id).replace(/^\/+/, '');
  if (!rel || rel.includes('\0') || rel.split('/').some(part => part === '..' || part === '')) throw new Error('Unsafe backup id');
  const root = path.join(VAULT_DIR, '.safire-backups');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep) && abs !== root) throw new Error('Backup path escapes vault');
  assertNoReparsePoints(abs);
  return { rel, abs };
}

function attachmentContentType(rel) {
  const ext = path.extname(rel).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.log': 'text/plain' })[ext] || 'application/octet-stream';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function attachmentBrowserPage(rel, contentType, textContent = '') {
  const name = path.basename(rel);
  const encoded = encodeURIComponent(rel);
  const rawUrl = `/api/attachment?path=${encoded}&raw=1`;
  const downloadUrl = `/api/attachment?path=${encoded}&download=1`;
  const isImage = contentType.startsWith('image/');
  const isText = contentType.startsWith('text/') || ['application/json'].includes(contentType);
  const preview = isImage
    ? `<img class="preview-img" src="${rawUrl}" alt="${escapeHtml(name)}">`
    : isText
      ? `<pre>${escapeHtml(textContent)}</pre>`
    : `<iframe title="${escapeHtml(name)}" src="${rawUrl}" sandbox></iframe>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)} - Safire Attachment</title><style>
    :root{color-scheme:dark;--ember:#ff8a1c;--gold:#ffe66d;--aqua:#2cecff;--ink:#f8fbff;--muted:#9fb0cb;--line:rgba(255,255,255,.14)}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 18% 8%,rgba(255,138,28,.25),transparent 28%),linear-gradient(135deg,#070812,#11142d 60%,#080812);color:var(--ink);font-family:Inter,Segoe UI,system-ui,sans-serif;display:flex;flex-direction:column}header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--line);background:rgba(8,10,22,.92);backdrop-filter:blur(18px)}button,a{font:inherit}.back{border:0;border-radius:14px;padding:11px 15px;background:linear-gradient(135deg,var(--gold),var(--ember));color:#160b04;font-weight:900;text-decoration:none;cursor:pointer}.title{min-width:0}.title h1{margin:0;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.title p{margin:2px 0 0;color:var(--muted);font-size:13px}.spacer{flex:1}.download{border:1px solid var(--line);border-radius:14px;padding:10px 13px;color:var(--ink);text-decoration:none;background:rgba(255,255,255,.07)}main{flex:1;min-height:0;padding:18px;display:grid}.frame{min-height:0;border:1px solid var(--line);border-radius:18px;background:rgba(0,0,0,.28);overflow:auto}pre{margin:0;padding:20px;white-space:pre-wrap;word-break:break-word;font-family:Cascadia Mono,Consolas,monospace;line-height:1.55;color:#eef6ff}.preview-img{max-width:100%;max-height:calc(100vh - 110px);display:block;margin:auto}iframe{width:100%;height:calc(100vh - 120px);border:0;background:#fff}
  </style></head><body><header><button class="back" onclick="location.href='/'">← Back to Safire</button><div class="title"><h1>${escapeHtml(name)}</h1><p>Attachment preview — use Back to Safire when done.</p></div><div class="spacer"></div><a class="download" href="${downloadUrl}">Download file</a></header><main><div class="frame">${preview}</div></main></body></html>`;
}

function resolveAttachmentPath(raw = '') {
  const rel = slash(raw).replace(/^\/+/, '');
  if (!rel || rel.includes('\0') || rel.split('/').some(part => part === '..' || part === '')) throw new Error('Unsafe attachment path');
  if (!rel.startsWith('Attachments/')) throw new Error('Attachments must live under Attachments/');
  const abs = path.resolve(VAULT_DIR, rel);
  if (!abs.startsWith(VAULT_DIR + path.sep)) throw new Error('Attachment path escapes vault');
  assertNoReparsePoints(abs);
  return { rel, abs };
}

function safeAttachmentName(name = 'attachment') {
  const parsed = path.parse(safeFilename(name) || 'attachment');
  const stem = (parsed.name || 'attachment').slice(0, 80).replace(/[^A-Za-z0-9._ -]/g, '-');
  const ext = (parsed.ext || '.bin').slice(0, 16).replace(/[^A-Za-z0-9.]/g, '');
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${stem}${ext}`;
}

function todayName() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const DEFAULT_WORKSPACE = { pinnedNotes: [], recentNotes: [], savedSearches: [] };
function workspacePath() { return path.join(VAULT_DIR, '.safire', 'workspace.json'); }
function workspaceId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
async function readWorkspace() {
  try {
    const parsed = JSON.parse(await fs.readFile(workspacePath(), 'utf8'));
    return {
      pinnedNotes: Array.isArray(parsed.pinnedNotes) ? [...new Set(parsed.pinnedNotes.filter(p => typeof p === 'string'))].slice(0, 24) : [],
      recentNotes: Array.isArray(parsed.recentNotes) ? parsed.recentNotes.filter(item => item && typeof item.path === 'string' && Number.isFinite(item.openedAt)).slice(0, 12) : [],
      savedSearches: Array.isArray(parsed.savedSearches) ? parsed.savedSearches.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.query === 'string' && Number.isFinite(item.createdAt)).slice(0, 20) : [],
    };
  } catch { return { ...DEFAULT_WORKSPACE, pinnedNotes: [], recentNotes: [], savedSearches: [] }; }
}
async function writeWorkspace(next) {
  await fs.mkdir(path.dirname(workspacePath()), { recursive: true });
  await fs.writeFile(workspacePath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}
async function pruneWorkspace(workspace) {
  const exists = async (notePath) => {
    try { await fs.access(resolveNotePath(notePath).abs); return true; } catch { return false; }
  };
  workspace.pinnedNotes = (await Promise.all(workspace.pinnedNotes.map(async p => (await exists(p)) ? p : null))).filter(Boolean);
  workspace.recentNotes = (await Promise.all(workspace.recentNotes.map(async item => (await exists(item.path)) ? item : null))).filter(Boolean);
  return workspace;
}
function parseTasks(content, notePath) {
  const tasks = [];
  let inFence = false;
  const lines = content.split(String.fromCharCode(13)).join('').split(String.fromCharCode(10));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = line.match(/^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.*)$/);
    if (match) tasks.push({ id: `${notePath}:${index + 1}`, path: notePath, line: index + 1, text: match[4].trim(), completed: match[2].toLowerCase() === 'x' });
  }
  return tasks;
}
async function allTasks(state = 'open') {
  const notes = await allNotesWithContent();
  const tasks = notes.flatMap(note => parseTasks(note.content, note.rel));
  const filtered = state === 'completed' ? tasks.filter(task => task.completed) : state === 'all' ? tasks : tasks.filter(task => !task.completed);
  return filtered.sort((a, b) => Number(a.completed) - Number(b.completed) || a.path.localeCompare(b.path) || a.line - b.line);
}
async function toggleTaskAtLine(rawPath, rawLine) {
  const { rel, abs } = resolveNotePath(rawPath);
  const lineNumber = Number(rawLine);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) throw new Error('Task line must be a positive integer');
  const content = await fs.readFile(abs, 'utf8');
  const newline = content.includes(String.fromCharCode(13, 10)) ? String.fromCharCode(13, 10) : String.fromCharCode(10);
  const lines = content.split(String.fromCharCode(13)).join('').split(String.fromCharCode(10));
  const index = lineNumber - 1;
  const match = lines[index]?.match(/^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.*)$/);
  if (!match) throw new Error('No supported task exists on that line');
  const nextState = match[2].toLowerCase() === 'x' ? ' ' : 'x';
  lines[index] = `${match[1]}${nextState}${match[3]}${match[4]}`;
  const backup = await backupIfExists(abs);
  await fs.writeFile(abs, lines.join(newline), 'utf8');
  return { task: parseTasks(lines.join('\n'), rel).find(task => task.line === lineNumber), backup };
}
function safeCaptureTag(raw = '') {
  const tag = String(raw).trim().replace(/^#/, '');
  if (!tag) return '';
  if (!/^[A-Za-z0-9_/-]{1,80}$/.test(tag)) throw new Error('Capture tag contains unsupported characters');
  return tag;
}
function renderTemplate(content, { title, now = new Date() }) {
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5);
  return content.replaceAll('{{date}}', date).replaceAll('{{time}}', time).replaceAll('{{title}}', title);
}

const DEFAULT_WEB_CLIP_TEMPLATES = [
  { id: 'article', name: 'Article', folder: 'Articles', description: 'Readable article with citations and footnotes.' },
  { id: 'recipe', name: 'Recipe', folder: 'Recipes', description: 'Ingredients, steps, servings, and nutrition.' },
  { id: 'reference', name: 'Reference', folder: 'References', description: 'Book, film, podcast, and other cultural references.' },
  { id: 'academic-paper', name: 'Academic paper', folder: 'Academic Papers', description: 'Abstract, authors, citations, code, and math-friendly Markdown.' },
];

function webClipTemplatesPath() { return path.join(settingsDir(), 'web-clip-templates.json'); }
function clipText(value = '') { return decodeHtml(String(value)).replace(/\s+/g, ' ').trim(); }
function decodeHtml(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(x[\da-f]+|\d+);/gi, (_m, code) => {
      const value = String(code).toLowerCase().startsWith('x') ? parseInt(String(code).slice(1), 16) : parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : '';
    });
}
function yamlValue(value = '') {
  const compact = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replaceAll(String.fromCharCode(13), ' ').replaceAll(String.fromCharCode(10), ' ');
  return `"${compact}"`;
}

const EVIDENCE_SOURCE_TYPES = new Set(['url', 'local_file', 'manual_observation', 'tool_result']);
const EVIDENCE_STATUSES = new Set(['verified', 'inferred', 'stale', 'conflicting', 'unavailable']);

function evidenceValue(raw = '') {
  const value = String(raw).trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    try { return String(JSON.parse(value)); } catch { /* Fall through to readable YAML text. */ }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function evidenceDate(value = '') {
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseEvidenceReceipts(content = '', notePath = '') {
  const receipts = [];
  const blocks = String(content).matchAll(/^\s*```safire-evidence\s*\x0d?\n([\s\S]*?)^\s*```\s*$/gim);
  let index = 0;
  for (const match of blocks) {
    const raw = {};
    for (const line of match[1].split('\n')) {
      const separator = line.indexOf(':');
      if (separator < 1 || /^\s*#/.test(line)) continue;
      raw[line.slice(0, separator).trim()] = evidenceValue(line.slice(separator + 1));
    }
    const sourceType = EVIDENCE_SOURCE_TYPES.has(raw.source_type) ? raw.source_type : 'manual_observation';
    const status = EVIDENCE_STATUSES.has(raw.status) ? raw.status : 'unavailable';
    const freshness = raw.freshness || raw.expires_at || '';
    const freshnessDate = evidenceDate(freshness);
    const receipt = {
      id: raw.id || `${notePath || 'note'}:evidence:${index + 1}`,
      claim: raw.claim || raw.label || '',
      sourceType,
      source: raw.source || raw.source_url_or_path || '',
      observedAt: raw.observed_at || '',
      action: raw.action || raw.action_performed || '',
      verification: raw.verification || raw.predicate || raw.test || '',
      status,
      freshness,
      excerpt: raw.excerpt || raw.evidence_excerpt || '',
      hash: raw.hash || raw.sha256 || '',
      privateNotes: raw.private_notes || raw.notes || '',
      expired: freshnessDate !== null && freshnessDate <= Date.now(),
    };
    if (receipt.claim || raw.id) receipts.push(receipt);
    index += 1;
  }
  return receipts;
}

function evidenceSummary(receipts = []) {
  return {
    count: receipts.length,
    verified: receipts.filter(receipt => receipt.status === 'verified').length,
    stale: receipts.filter(receipt => receipt.status === 'stale').length,
    conflicting: receipts.filter(receipt => receipt.status === 'conflicting').length,
    expired: receipts.filter(receipt => receipt.expired).length,
  };
}

function searchEvidenceReceipt(receipt) {
  // Search results are broad, local index output. Keep receipt-only details behind
  // the explicit note evidence endpoint so a generic search never exposes private notes.
  return {
    id: receipt.id,
    claim: receipt.claim,
    sourceType: receipt.sourceType,
    observedAt: receipt.observedAt,
    status: receipt.status,
    freshness: receipt.freshness,
    expired: receipt.expired,
  };
}

function publicSearchContent(content = '') {
  return stripPrivateEvidenceFields(content);
}

function evidenceSearchFilters(query = {}) {
  const normalize = value => String(value || '').trim().toLowerCase();
  const dateBound = (value, end = false) => {
    const text = String(value || '').trim();
    if (!text) return null;
    return evidenceDate(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}${end ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}` : text);
  };
  const state = normalize(query.state || query.stale);
  return {
    status: normalize(query.status), source: normalize(query.source), state,
    expired: ['1', 'true', 'yes', 'expired'].includes(normalize(query.expired)),
    from: dateBound(query.from || query.after), to: dateBound(query.to || query.before, true),
  };
}

function receiptMatchesFilters(receipt, filters) {
  if (filters.status && receipt.status !== filters.status) return false;
  if (filters.source && receipt.sourceType !== filters.source) return false;
  if (filters.expired && !receipt.expired) return false;
  if (filters.state === 'stale' && receipt.status !== 'stale') return false;
  if (filters.state === 'conflicting' && receipt.status !== 'conflicting') return false;
  if (filters.state === 'expired' && !receipt.expired) return false;
  const observed = evidenceDate(receipt.observedAt);
  if (filters.from !== null && (observed === null || observed < filters.from)) return false;
  if (filters.to !== null && (observed === null || observed > filters.to)) return false;
  return true;
}
function plainHtml(value = '') { return clipText(String(value).replace(/<[^>]*>/g, ' ')); }
function htmlAttr(tag = '', name = '') {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}
function htmlMeta(html = '', names = []) {
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) || []) {
    const key = (htmlAttr(tag, 'name') || htmlAttr(tag, 'property') || htmlAttr(tag, 'itemprop')).toLowerCase();
    if (names.includes(key)) return htmlAttr(tag, 'content');
  }
  return '';
}
function extractJsonLd(html = '') {
  const records = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { records.push(JSON.parse(decodeHtml(match[1]))); } catch { /* Ignore malformed publisher data. */ }
  }
  return records.flatMap(record => Array.isArray(record) ? record : record?.['@graph'] ? record['@graph'] : [record]).filter(Boolean);
}
function schemaType(record, type) {
  const types = Array.isArray(record?.['@type']) ? record['@type'] : [record?.['@type']];
  return types.some(item => String(item).toLowerCase() === type.toLowerCase());
}
function firstSchema(records, type) { return records.find(record => schemaType(record, type)) || null; }
function absoluteUrl(value, source) {
  try { return new URL(value, source).toString(); } catch { return ''; }
}
function markdownFromHtml(html = '', sourceUrl = '') {
  let text = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|canvas|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs, label) => {
      const href = absoluteUrl(htmlAttr(attrs, 'href'), sourceUrl);
      const title = plainHtml(label);
      return href && title ? `[${title}](${href})` : title;
    })
    .replace(/<img\b([^>]*)>/gi, (_match, attrs) => {
      const src = absoluteUrl(htmlAttr(attrs, 'src'), sourceUrl);
      const alt = htmlAttr(attrs, 'alt');
      return src ? `![${alt}](${src})` : '';
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, depth, value) => `\n\n${'#'.repeat(Number(depth))} ${plainHtml(value)}\n\n`)
    .replace(/<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, tag, value) => tag.toLowerCase() === 'pre' ? `\n\n\`\`\`\n${decodeHtml(value).replace(/<[^>]*>/g, '')}\n\`\`\`\n\n` : `\`${plainHtml(value)}\``)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, value) => `\n\n> ${plainHtml(value)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, value) => `\n- ${plainHtml(value)}`)
    .replace(/<(p|div|section|article|main|figure|figcaption|table|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, value) => `\n\n${plainHtml(value)}\n\n`)
    .replace(/<[^>]*>/g, '');
  text = decodeHtml(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}
function extractArticleHtml(html = '') {
  const article = String(html).match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i);
  return article?.[2] || String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || String(html);
}
function extractFootnotes(html = '') {
  const section = String(html).match(/<(?:section|div|ol)\b[^>]*(?:footnote|footnotes|endnote)[^>]*>([\s\S]*?)<\/(?:section|div|ol)>/i)?.[1] || '';
  return [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(match => plainHtml(match[1])).filter(Boolean);
}
function extractCitations(html = '', sourceUrl = '') {
  const seen = new Set();
  const citations = [];
  for (const match of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = absoluteUrl(htmlAttr(match[1], 'href'), sourceUrl);
    const label = plainHtml(match[2]) || href;
    if (!href || href === sourceUrl || seen.has(href)) continue;
    seen.add(href);
    citations.push({ label, href });
  }
  return citations;
}
function recipeInstructions(value) {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap(item => typeof item === 'string' ? [clipText(item)] : item && typeof item === 'object' ? recipeInstructions(item.itemListElement || item.text || item.name) : []).filter(Boolean);
}
function safeWebClipTemplate(template = {}) {
  const id = String(template.id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const name = clipText(template.name || 'Custom template').slice(0, 80);
  const folder = clipText(template.folder || 'Custom').replace(/[<>:"|?*\\/]/g, '-').slice(0, 80);
  const body = String(template.body || '').trim().slice(0, 30000);
  if (!id || !name || !folder || !body) throw new Error('Custom template needs an id, name, folder, and Markdown body');
  return { id, name, folder, description: clipText(template.description || 'Custom web clip template').slice(0, 200), body };
}
async function readWebClipTemplates() {
  try {
    const parsed = JSON.parse(await fs.readFile(webClipTemplatesPath(), 'utf8'));
    const custom = Array.isArray(parsed?.custom) ? parsed.custom.map(safeWebClipTemplate) : [];
    return [...DEFAULT_WEB_CLIP_TEMPLATES, ...custom.filter(item => !DEFAULT_WEB_CLIP_TEMPLATES.some(defaultTemplate => defaultTemplate.id === item.id))];
  } catch { return [...DEFAULT_WEB_CLIP_TEMPLATES]; }
}
async function saveWebClipTemplate(input) {
  const template = safeWebClipTemplate(input);
  if (DEFAULT_WEB_CLIP_TEMPLATES.some(item => item.id === template.id)) throw new Error('Built-in template IDs are reserved');
  const existing = await readWebClipTemplates();
  const custom = existing.filter(item => item.body && item.id !== template.id);
  custom.push(template);
  await fs.mkdir(settingsDir(), { recursive: true });
  await fs.writeFile(webClipTemplatesPath(), JSON.stringify({ custom }, null, 2), 'utf8');
  return template;
}
function renderWebClip(template, data) {
  if (template.body) {
    const variables = {
      title: data.title, url: data.url, author: data.author, description: data.description, captured_at: data.capturedAt,
      content: data.content, citations: data.citations.map(item => `- [${item.label}](${item.href})`).join('\n'),
      footnotes: data.footnotes.map((item, index) => `${index + 1}. ${item}`).join('\n'),
    };
    return template.body.replace(/{{\s*([a-z_]+)\s*}}/gi, (_match, key) => variables[key.toLowerCase()] ?? '');
  }
  const frontmatter = `---\ntitle: ${yamlValue(data.title)}\nsource: ${yamlValue(data.url)}\ncaptured_at: ${yamlValue(data.capturedAt)}\ntemplate: ${yamlValue(template.id)}\nauthor: ${yamlValue(data.author)}\ndescription: ${yamlValue(data.description)}\ntags:\n  - web-clip\n  - ${template.id}\n---\n`;
  if (template.id === 'recipe') {
    const ingredients = data.recipe?.recipeIngredient || [];
    const instructions = recipeInstructions(data.recipe?.recipeInstructions);
    const nutrition = data.recipe?.nutrition || {};
    return `${frontmatter}\n# ${data.title}\n\n${data.description}\n\n## Ingredients\n${ingredients.map(item => `- ${clipText(item)}`).join('\n') || '- Add ingredients'}\n\n## Instructions\n${instructions.map((item, index) => `${index + 1}. ${item}`).join('\n') || '1. Add steps'}\n\n## Details\n| Field | Value |\n| --- | --- |\n| Yield | ${clipText(data.recipe?.recipeYield || '')} |\n| Prep time | ${clipText(data.recipe?.prepTime || '')} |\n| Cook time | ${clipText(data.recipe?.cookTime || '')} |\n\n## Nutrition\n| Field | Value |\n| --- | --- |\n| Calories | ${clipText(nutrition.calories || '')} |\n\n## Source\n[Open original](${data.url})\n`;
  }
  const citations = data.citations.length ? `\n\n## Citations\n${data.citations.map(item => `- [${item.label}](${item.href})`).join('\n')}` : '';
  const footnotes = data.footnotes.length ? `\n\n## Footnotes\n${data.footnotes.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '';
  const articleLead = template.id === 'academic-paper' ? `## Abstract\n\n${data.description || data.content.slice(0, 600)}` : data.description;
  return `${frontmatter}\n# ${data.title}\n\n${articleLead}\n\n## Saved content\n\n${data.content || '_No readable page content was found. Use the source link above._'}${citations}${footnotes}\n\n## Source\n[Open original](${data.url})\n`;
}
function isPublicIp(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  if (family === 6) {
    if (normalized.startsWith('::ffff:')) return isPublicIp(normalized.slice('::ffff:'.length));
    return !(normalized === '::' || normalized === '::1' || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff') || normalized.startsWith('2001:db8:'));
  }
  return false;
}

async function resolvePublicHost(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local')) throw new Error('Safire cannot fetch local or private-network pages');
  const literalFamily = net.isIP(normalized);
  const records = literalFamily ? [{ address: normalized, family: literalFamily }] : await dns.lookup(normalized, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicIp(record.address))) throw new Error('Safire cannot fetch local or private-network pages');
  return records;
}

export async function assertPublicWebUrl(parsed) {
  if (!(parsed instanceof URL) || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https pages can be clipped');
  return resolvePublicHost(parsed.hostname);
}

function publicLookup(hostname, options, callback) {
  resolvePublicHost(hostname)
    .then(records => {
      const matched = options?.family ? records.find(record => record.family === options.family) : records[0];
      if (!matched) throw new Error('No public address matches the requested network family');
      callback(null, matched.address, matched.family);
    })
    .catch(error => callback(error));
}

const webClipAgent = new Agent({ connect: { lookup: publicLookup } });

async function fetchWebPage(sourceUrl) {
  const parsed = new URL(sourceUrl);
  await assertPublicWebUrl(parsed);
  const response = await undiciFetch(parsed, { dispatcher: webClipAgent, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Safire Web Clipper/1.0', Accept: 'text/html,application/xhtml+xml' } });
  if (!response.ok) throw new Error(`Could not fetch page (${response.status})`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('html')) throw new Error('The page did not return HTML');
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error('The page is too large to clip');
  return html;
}
async function createWebClip(input = {}) {
  const url = String(input.url || '').trim();
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('A valid source URL is required'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('A web clip needs an http or https URL');
  const html = typeof input.html === 'string' && input.html.trim() ? input.html : await fetchWebPage(parsedUrl.toString());
  if (html.length > 2_000_000) throw new Error('The captured page is too large');
  const templates = await readWebClipTemplates();
  const template = templates.find(item => item.id === String(input.templateId || 'article'));
  if (!template) throw new Error('Unknown web clip template');
  const schema = extractJsonLd(html);
  const recipe = firstSchema(schema, 'Recipe');
  const title = clipText(input.title || recipe?.name || htmlMeta(html, ['og:title', 'twitter:title']) || String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || parsedUrl.hostname).slice(0, 180);
  const description = clipText(recipe?.description || htmlMeta(html, ['description', 'og:description', 'twitter:description'])).slice(0, 1000);
  const authorValue = recipe?.author || htmlMeta(html, ['author', 'article:author']);
  const author = clipText(Array.isArray(authorValue) ? authorValue.map(item => typeof item === 'object' ? item.name : item).join(', ') : typeof authorValue === 'object' ? authorValue.name : authorValue).slice(0, 300);
  const articleHtml = extractArticleHtml(html);
  const data = {
    title: title || 'Untitled web clip', url: parsedUrl.toString(), author, description, recipe,
    content: markdownFromHtml(articleHtml, parsedUrl.toString()), citations: extractCitations(articleHtml, parsedUrl.toString()),
    footnotes: extractFootnotes(articleHtml), capturedAt: new Date().toISOString(),
  };
  const baseName = safeFilename(data.title).slice(0, 140) || 'Untitled web clip';
  const folder = `Web Clips/${template.folder}`;
  let rel = `${folder}/${baseName}.md`;
  let attempt = 2;
  while (fssync.existsSync(resolveNotePath(rel).abs)) rel = `${folder}/${baseName} (${attempt++}).md`;
  const { abs } = resolveNotePath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const content = renderWebClip(template, data);
  await fs.writeFile(abs, content, 'utf8');
  return { path: rel, title: data.title, template: template.id, source: data.url, content };
}

function publicVaultLabel() {
  return path.basename(VAULT_DIR) || 'Safire Vault';
}

app.get('/api/health', async (_req, res) => res.json({ ok: true, app: 'Safire', vault: publicVaultLabel() }));

app.get('/api/tree', async (_req, res, next) => {
  try { res.json({ vault: publicVaultLabel(), tree: await buildTree() }); } catch (err) { next(err); }
});

app.get('/api/notes', async (_req, res, next) => {
  try {
    const rels = await walkMarkdown(VAULT_DIR);
    const notes = [];
    for (const rel of rels) notes.push(await noteMeta(rel));
    res.json({ vault: publicVaultLabel(), notes });
  } catch (err) { next(err); }
});

app.get('/api/note', async (req, res, next) => {
  try {
    const { rel, abs } = resolveNotePath(req.query.path || 'Welcome.md');
    const content = await fs.readFile(abs, 'utf8');
    res.json({ path: rel, title: titleFromPath(rel), content, tags: parseTags(content), links: parseLinks(content) });
  } catch (err) { next(err); }
});

app.post('/api/note', async (req, res, next) => {
  try {
    const wanted = req.body.path || req.body.title || 'Untitled';
    const safe = slash(safeFilename(wanted)).replace(/^\/+/, '') || 'Untitled';
    const { rel, abs } = resolveNotePath(safe);
    if (fssync.existsSync(abs)) return res.status(409).json({ error: 'Note already exists', path: rel });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const initial = req.body.content ?? `# ${titleFromPath(rel)}\n\n`;
    await fs.writeFile(abs, initial, 'utf8');
    res.status(201).json({ path: rel, content: initial });
  } catch (err) { next(err); }
});

app.put('/api/note', async (req, res, next) => {
  try {
    const { rel, abs } = resolveNotePath(req.body.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const backup = await backupIfExists(abs);
    await fs.writeFile(abs, String(req.body.content ?? ''), 'utf8');
    res.json({ ok: true, path: rel, backup });
  } catch (err) { next(err); }
});

app.delete('/api/note', async (req, res, next) => {
  try {
    const { rel, abs } = resolveNotePath(req.body.path);
    const backup = await backupIfExists(abs);
    await fs.rm(abs, { force: true });
    res.json({ ok: true, path: rel, backup });
  } catch (err) { next(err); }
});

app.post('/api/folder', async (req, res, next) => {
  try {
    const { rel, abs } = resolveVaultPath(req.body.path || 'New Folder');
    if (!rel) throw new Error('Folder name required');
    await fs.mkdir(abs, { recursive: true });
    res.status(201).json({ path: rel });
  } catch (err) { next(err); }
});

app.post('/api/rename', async (req, res, next) => {
  try {
    const fromRaw = req.body.from;
    const toRaw = req.body.to;
    const fromIsNote = String(fromRaw).toLowerCase().endsWith('.md');
    const toIsNote = String(toRaw).toLowerCase().endsWith('.md') || fromIsNote;
    const from = fromIsNote ? resolveNotePath(fromRaw) : resolveVaultPath(fromRaw);
    const to = toIsNote ? resolveNotePath(toRaw) : resolveVaultPath(toRaw);
    if (!fssync.existsSync(from.abs)) return res.status(404).json({ error: 'Source not found' });
    if (fssync.existsSync(to.abs)) return res.status(409).json({ error: 'Destination already exists' });
    await fs.mkdir(path.dirname(to.abs), { recursive: true });
    await fs.rename(from.abs, to.abs);
    res.json({ ok: true, from: from.rel, to: to.rel });
  } catch (err) { next(err); }
});

app.post('/api/daily', async (_req, res, next) => {
  try {
    const rel = `Daily Notes/${todayName()}.md`;
    const { abs } = resolveNotePath(rel);
    if (!fssync.existsSync(abs)) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, `# ${todayName()}\n\n## Notes\n\n## Tasks\n\n- [ ] \n\n#daily\n`, 'utf8');
    }
    res.json({ path: rel });
  } catch (err) { next(err); }
});

app.post('/api/capture', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new Error('Capture text is required');
    if (text.length > 10000) throw new Error('Capture text is too long');
    const tag = safeCaptureTag(req.body?.tag);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rel = `Inbox/${stamp}-${Math.random().toString(36).slice(2, 6)}.md`;
    const { abs } = resolveNotePath(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const content = `# Quick capture\n\n${text}\n${tag ? `\n#${tag}\n` : ''}`;
    await fs.writeFile(abs, content, 'utf8');
    res.status(201).json({ path: rel, content });
  } catch (err) { next(err); }
});

app.get('/api/web-clip/templates', async (_req, res, next) => {
  try { res.json({ templates: await readWebClipTemplates() }); } catch (err) { next(err); }
});

app.post('/api/web-clip/templates', async (req, res, next) => {
  try { res.status(201).json({ template: await saveWebClipTemplate(req.body || {}) }); } catch (err) { next(err); }
});

app.post('/api/web-clip', async (req, res, next) => {
  try { res.status(201).json(await createWebClip(req.body || {})); } catch (err) { next(err); }
});

app.get('/api/templates', async (_req, res, next) => {
  try {
    const root = path.join(VAULT_DIR, 'Templates');
    const files = (await walkMarkdown(root).catch(() => [])).map(rel => `Templates/${rel}`);
    res.json({ templates: files.map(file => ({ path: file, title: titleFromPath(file) })) });
  } catch (err) { next(err); }
});

app.post('/api/template/instantiate', async (req, res, next) => {
  try {
    const template = resolveNotePath(req.body?.templatePath || '');
    if (!template.rel.startsWith('Templates/')) throw new Error('Template must live under Templates/');
    const source = await fs.readFile(template.abs, 'utf8');
    const destinationRaw = String(req.body?.destination || req.body?.title || '').trim();
    if (!destinationRaw) throw new Error('New note destination is required');
    const destination = resolveNotePath(destinationRaw);
    if (fssync.existsSync(destination.abs)) return res.status(409).json({ error: 'Note already exists', path: destination.rel });
    await fs.mkdir(path.dirname(destination.abs), { recursive: true });
    const title = String(req.body?.title || titleFromPath(destination.rel)).trim().slice(0, 200) || titleFromPath(destination.rel);
    const content = renderTemplate(source, { title });
    await fs.writeFile(destination.abs, content, 'utf8');
    res.status(201).json({ path: destination.rel, content });
  } catch (err) { next(err); }
});

app.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    const filters = evidenceSearchFilters(req.query);
    const hasEvidenceFilter = Boolean(filters.status || filters.source || filters.state || filters.expired || filters.from !== null || filters.to !== null);
    const notes = await allNotesWithContent();
    const results = (!q && !hasEvidenceFilter ? [] : notes.map(n => {
      const receipts = parseEvidenceReceipts(n.content, n.rel);
      const searchable = publicSearchContent(n.content);
      const matchingReceipts = receipts.filter(receipt => receiptMatchesFilters(receipt, filters));
      const textMatches = !q || n.rel.toLowerCase().includes(q) || searchable.toLowerCase().includes(q);
      const evidenceMatches = !hasEvidenceFilter || matchingReceipts.length > 0;
      if (!textMatches || !evidenceMatches) return null;
      return {
        path: n.rel, title: n.title, folder: slash(path.dirname(n.rel)) === '.' ? '' : slash(path.dirname(n.rel)), tags: parseTags(searchable),
        links: parseLinks(searchable), excerpt: excerpt(searchable), evidence: {
          ...evidenceSummary(receipts),
          receipts: (hasEvidenceFilter ? matchingReceipts : receipts).map(searchEvidenceReceipt),
        },
      };
    }).filter(Boolean));
    res.json({ query: q, filters, results });
  } catch (err) { next(err); }
});

app.get('/api/evidence', async (req, res, next) => {
  try {
    const { rel, abs } = resolveNotePath(req.query.path || 'Welcome.md');
    const receipts = parseEvidenceReceipts(await fs.readFile(abs, 'utf8'), rel);
    res.json({ path: rel, receipts, summary: evidenceSummary(receipts) });
  } catch (err) { next(err); }
});

app.get('/api/tasks', async (req, res, next) => {
  try {
    const state = ['open', 'completed', 'all'].includes(String(req.query.state)) ? String(req.query.state) : 'open';
    res.json({ state, tasks: await allTasks(state) });
  } catch (err) { next(err); }
});

app.post('/api/task/toggle', async (req, res, next) => {
  try { res.json({ ok: true, ...(await toggleTaskAtLine(req.body?.path, req.body?.line)) }); } catch (err) { next(err); }
});

app.get('/api/graph', async (_req, res, next) => {
  try {
    const notes = await allNotesWithContent();
    const resolveWikiLink = createWikiLinkResolver(notes);
    const links = [];
    for (const n of notes) {
      for (const linkTitle of n.links) {
        const resolution = resolveWikiLink(linkTitle);
        links.push({
          id: `link:${encodeURIComponent(n.rel)}:${encodeURIComponent(linkTitle)}`,
          source: n.rel,
          target: resolution.target,
          label: linkTitle,
          resolved: resolution.resolved,
          resolution: resolution.resolution,
        });
      }
    }
    const incoming = new Map(notes.map(n => [n.rel, 0]));
    const outgoing = new Map(notes.map(n => [n.rel, 0]));
    for (const link of links) {
      outgoing.set(link.source, (outgoing.get(link.source) || 0) + 1);
      if (link.resolved && incoming.has(link.target)) incoming.set(link.target, (incoming.get(link.target) || 0) + 1);
    }
    const nodes = notes.map(n => {
      const inDegree = incoming.get(n.rel) || 0;
      const outDegree = outgoing.get(n.rel) || 0;
      return {
        id: n.rel,
        label: n.title,
        tags: n.tags,
        folder: n.folder,
        size: n.size,
        mtime: n.mtime,
        inDegree,
        outDegree,
        degree: inDegree + outDegree,
        orphan: inDegree === 0 && outDegree === 0,
      };
    });
    res.json({ nodes, links });
  } catch (err) { next(err); }
});

app.get('/api/backlinks', async (req, res, next) => {
  try {
    const targetPath = normalizeNotePath(req.query.path || 'Welcome.md');
    const notes = await allNotesWithContent();
    const resolveWikiLink = createWikiLinkResolver(notes);
    const backlinks = notes.filter(n => n.rel !== targetPath && n.links.some(link => {
      const resolution = resolveWikiLink(link);
      return resolution.resolved && resolution.target.toLowerCase() === targetPath.toLowerCase();
    })).map(n => ({ path: n.rel, title: n.title, excerpt: excerpt(n.content) }));
    res.json({ path: targetPath, backlinks });
  } catch (err) { next(err); }
});

app.get('/api/settings', async (_req, res, next) => {
  try { res.json({ settings: await readSettings() }); } catch (err) { next(err); }
});

app.put('/api/settings', async (req, res, next) => {
  try { res.json({ settings: await writeSettings(req.body || {}) }); } catch (err) { next(err); }
});

app.get('/api/workspace', async (_req, res, next) => {
  try { res.json(await pruneWorkspace(await readWorkspace())); } catch (err) { next(err); }
});

app.post('/api/workspace/recent', async (req, res, next) => {
  try {
    const { rel, abs } = resolveNotePath(req.body?.path || '');
    await fs.access(abs);
    const workspace = await pruneWorkspace(await readWorkspace());
    workspace.recentNotes = [{ path: rel, openedAt: Date.now() }, ...workspace.recentNotes.filter(item => item.path !== rel)].slice(0, 12);
    res.json(await writeWorkspace(workspace));
  } catch (err) { next(err); }
});

app.post('/api/workspace/pin', async (req, res, next) => {
  try {
    const { rel, abs } = resolveNotePath(req.body?.path || '');
    await fs.access(abs);
    const workspace = await pruneWorkspace(await readWorkspace());
    workspace.pinnedNotes = [...new Set([...workspace.pinnedNotes, rel])].slice(0, 24);
    res.json(await writeWorkspace(workspace));
  } catch (err) { next(err); }
});

app.delete('/api/workspace/pin', async (req, res, next) => {
  try {
    const { rel } = resolveNotePath(req.body?.path || '');
    const workspace = await pruneWorkspace(await readWorkspace());
    workspace.pinnedNotes = workspace.pinnedNotes.filter(item => item !== rel);
    res.json(await writeWorkspace(workspace));
  } catch (err) { next(err); }
});

app.post('/api/workspace/search', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const query = String(req.body?.query || '').trim();
    if (!name || !query) throw new Error('Saved search name and query are required');
    if (name.length > 120 || query.length > 300) throw new Error('Saved search is too long');
    const workspace = await pruneWorkspace(await readWorkspace());
    workspace.savedSearches = [{ id: workspaceId(), name, query, createdAt: Date.now() }, ...workspace.savedSearches].slice(0, 20);
    res.status(201).json(await writeWorkspace(workspace));
  } catch (err) { next(err); }
});

app.delete('/api/workspace/search/:id', async (req, res, next) => {
  try {
    const workspace = await pruneWorkspace(await readWorkspace());
    workspace.savedSearches = workspace.savedSearches.filter(item => item.id !== req.params.id);
    res.json(await writeWorkspace(workspace));
  } catch (err) { next(err); }
});

app.get('/api/backups', async (req, res, next) => {
  try {
    const target = req.query.path ? normalizeNotePath(req.query.path) : '';
    const root = path.join(VAULT_DIR, '.safire-backups');
    const files = (await walkAllFiles(root)).filter(f => f.toLowerCase().endsWith('.bak'));
    const backups = [];
    for (const id of files) {
      const { abs } = resolveBackupId(id);
      const stat = await fs.stat(abs);
      const notePath = backupNoteFromName(id);
      if (target && notePath !== target) continue;
      const stamp = id.match(/\.(\d+)\.bak$/)?.[1];
      backups.push({ id, notePath, size: stat.size, createdAt: stamp ? Number(stamp) : stat.mtimeMs });
    }
    backups.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ backups });
  } catch (err) { next(err); }
});

app.get('/api/backup', async (req, res, next) => {
  try {
    const { rel, abs } = resolveBackupId(req.query.id || '');
    const content = await fs.readFile(abs, 'utf8');
    res.json({ id: rel, notePath: backupNoteFromName(rel), content });
  } catch (err) { next(err); }
});

app.post('/api/backup/restore', async (req, res, next) => {
  try {
    const { rel, abs } = resolveBackupId(req.body.id || '');
    const toPath = req.body.path ? normalizeNotePath(req.body.path) : backupNoteFromName(rel);
    const target = resolveNotePath(toPath);
    await fs.mkdir(path.dirname(target.abs), { recursive: true });
    const safetyBackup = await backupIfExists(target.abs);
    await fs.copyFile(abs, target.abs);
    res.json({ ok: true, path: target.rel, restoredFrom: rel, backup: safetyBackup });
  } catch (err) { next(err); }
});

app.post('/api/attachment', async (req, res, next) => {
  try {
    const name = safeAttachmentName(req.body.filename || 'attachment');
    const rel = `Attachments/${name}`;
    const { abs } = resolveAttachmentPath(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const raw = String(req.body.data || '');
    const match = raw.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    const buffer = match ? Buffer.from(match[3], match[2] ? 'base64' : 'utf8') : Buffer.from(raw, 'base64');
    if (buffer.length > 15 * 1024 * 1024) throw new Error('Attachment is larger than 15 MB');
    await fs.writeFile(abs, buffer);
    const markdown = attachmentContentType(rel).startsWith('image/') ? `![${name}](/api/attachment?path=${encodeURIComponent(rel)})` : `[${name}](/api/attachment?path=${encodeURIComponent(rel)})`;
    res.status(201).json({ path: rel, url: `/api/attachment?path=${encodeURIComponent(rel)}`, markdown, size: buffer.length });
  } catch (err) { next(err); }
});

app.get('/api/attachment', async (req, res, next) => {
  try {
    const { rel, abs } = resolveAttachmentPath(req.query.path || '');
    const contentType = attachmentContentType(rel);
    const forceRaw = req.query.raw === '1' || req.query.download === '1';
    const fetchDest = String(req.get('sec-fetch-dest') || '');
    const acceptsHtml = String(req.get('accept') || '').includes('text/html');
    if (!forceRaw && (fetchDest === 'document' || acceptsHtml)) {
      let textContent = '';
      if (contentType.startsWith('text/') || contentType === 'application/json') {
        textContent = await fs.readFile(abs, 'utf8');
      }
      res.type('html').send(attachmentBrowserPage(rel, contentType, textContent));
      return;
    }
    res.type(contentType);
    if (req.query.download === '1') res.attachment(path.basename(rel));
    res.sendFile(abs);
  } catch (err) { next(err); }
});

app.get('/api/vault-health', async (_req, res, next) => {
  try {
    const notes = await allNotesWithContent();
    const resolveWikiLink = createWikiLinkResolver(notes);
    const missingLinks = [];
    const linkedTargets = new Set();
    for (const note of notes) for (const link of note.links) {
      const resolution = resolveWikiLink(link);
      if (resolution.resolved) linkedTargets.add(resolution.target.toLowerCase());
      else missingLinks.push({ from: note.rel, target: link });
    }
    const orphanNotes = notes.filter(note => !linkedTargets.has(note.rel.toLowerCase()) && note.links.length === 0).map(note => note.rel);
    const backupRoot = path.join(VAULT_DIR, '.safire-backups');
    const backups = await walkAllFiles(backupRoot);
    res.json({ noteCount: notes.length, tagCount: new Set(notes.flatMap(n => n.tags)).size, linkCount: notes.reduce((sum, n) => sum + n.links.length, 0), missingLinks, orphanNotes, backupCount: backups.length });
  } catch (err) { next(err); }
});

app.use(express.static(DIST_DIR));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

function publicErrorMessage(error) {
  if (error?.type === 'entity.parse.failed') return 'Invalid JSON request';
  const fileSystemMessages = {
    EACCES: 'Safire could not access the requested item',
    EEXIST: 'The requested item already exists',
    EISDIR: 'The requested item is not a file',
    ENOENT: 'The requested item was not found',
    ENOTDIR: 'The requested folder was not found',
    EPERM: 'Safire could not access the requested item',
  };
  if (fileSystemMessages[error?.code]) return fileSystemMessages[error.code];
  let message = String(error?.message || 'Request failed').replace(/[\r\n]+/g, ' ').slice(0, 300);
  if (VAULT_DIR) {
    const escapedVault = VAULT_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    message = message.replace(new RegExp(escapedVault, 'gi'), '[vault]');
  }
  message = message.replace(/[A-Za-z]:[\\/][^\s"'`),}\]]+/g, '[local path]');
  return message || 'Request failed';
}

app.use((err, _req, res, _next) => {
  const message = publicErrorMessage(err);
  console.error(`Safire request failed: ${message}`);
  res.status(400).json({ error: message });
});

export async function startSafireServer(options = {}) {
  VAULT_DIR = resolveConfiguredVaultPath({ vaultDir: options.vaultDir, configPath: options.vaultConfigPath });
  DIST_DIR = path.resolve(options.distDir || DEFAULT_DIST_DIR);
  await ensureVault();
  VAULT_DIR = await fs.realpath(VAULT_DIR);
  const host = loopbackHost(options.host || HOST);
  const port = Number(options.port ?? PORT);
  const log = typeof options.log === 'function' ? options.log : console.log;
  return await new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const urlHost = host === '::1' ? '[::1]' : host;
      const url = `http://${urlHost}:${actualPort}`;
      log(`Safire running at ${url}`);
      log(`Vault: ${VAULT_DIR}`);
      resolve({ server, url, vault: VAULT_DIR, port: actualPort, host });
    });
  });
}

if (IS_CLI) {
  await startSafireServer();
}
