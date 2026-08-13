import React from 'react';
import { createRoot } from 'react-dom/client';
import { marked, Renderer, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import pkg from '../package.json';
import { GraphView } from './GraphView';
import './styles.css';

const APP_VERSION = pkg.version;

type NoteMeta = { path: string; title: string; folder: string; size: number; mtime: number; tags: string[]; links: string[]; excerpt: string };
type TreeNode = { type: 'folder'|'note'; name: string; path: string; title?: string; children?: TreeNode[] };
type GraphNode = { id: string; label: string; tags: string[]; folder: string; size: number; mtime: number; inDegree: number; outDegree: number; degree: number; orphan: boolean };
type GraphLink = { id: string; source: string; target: string; label: string; resolved: boolean; resolution: 'exact-path' | 'unique-title' | 'ambiguous' | 'missing' };
type Graph = { nodes: GraphNode[]; links: GraphLink[] };
type GraphPanel = { mode: 'preview' | 'edit' };
type Mode = 'split'|'edit'|'preview'|'graph';
type ThemeMode = 'dark' | 'light';
type ImageSize = 'small' | 'medium' | 'large' | 'full' | 'original';
type SafireSettings = { autosave: boolean; autosaveDelay: number; defaultMode: Mode; startupNote: string; dailyNotesFolder: string; backupRetentionDays: number; confirmDeletes: boolean; theme: ThemeMode; fitImagesToPage: boolean };
type WorkspaceState = { pinnedNotes: string[]; recentNotes: { path: string; openedAt: number }[]; savedSearches: { id: string; name: string; query: string; createdAt: number }[] };
type VaultTask = { id: string; path: string; line: number; text: string; completed: boolean };
type TemplateItem = { path: string; title: string };
type WebClipTemplate = { id: string; name: string; folder: string; description: string; body?: string };
type WorkspaceView = 'note' | 'home' | 'tasks';
type BackupItem = { id: string; notePath: string; size: number; createdAt: number };
type VaultHealth = { noteCount: number; tagCount: number; linkCount: number; missingLinks: { from: string; target: string }[]; orphanNotes: string[]; backupCount: number };
type AttachmentViewerState = { url: string; name: string; kind: 'image' | 'text' | 'document' };
type ImageResizeMenuState = { index: number; x: number; y: number; alt: string; src: string; size: ImageSize | null };
type NoteOutlineItem = { id: string; label: string; depth: number };
type EvidenceSourceType = 'url' | 'local_file' | 'manual_observation' | 'tool_result';
type EvidenceStatus = 'verified' | 'inferred' | 'stale' | 'conflicting' | 'unavailable';
type EvidenceReceipt = { id: string; claim: string; sourceType: EvidenceSourceType; source: string; observedAt: string; action: string; verification: string; status: EvidenceStatus; freshness: string; excerpt: string; hash: string; privateNotes: string; expired: boolean };
type EvidenceDraft = Omit<EvidenceReceipt, 'id' | 'expired'>;
type SafireDialog =
  | { kind: 'input'; title: string; message?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string; danger?: boolean; resolve: (value: string | null) => void }
  | { kind: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; resolve: (value: boolean) => void };

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
  return res.json();
};

const EVIDENCE_SOURCES: { value: EvidenceSourceType; label: string }[] = [
  { value: 'url', label: 'URL' }, { value: 'local_file', label: 'Local file' }, { value: 'manual_observation', label: 'Manual observation' }, { value: 'tool_result', label: 'Tool result' },
];
const EVIDENCE_STATUSES: EvidenceStatus[] = ['verified', 'inferred', 'stale', 'conflicting', 'unavailable'];
const EVIDENCE_FIELDS: { key: keyof EvidenceDraft; label: string }[] = [
  { key: 'claim', label: 'Claim / label' }, { key: 'sourceType', label: 'Source type' }, { key: 'source', label: 'Source URL or local path' }, { key: 'observedAt', label: 'Observed at' }, { key: 'action', label: 'Action performed' }, { key: 'verification', label: 'Verification predicate / test' }, { key: 'status', label: 'Result status' }, { key: 'freshness', label: 'Freshness / expiry' }, { key: 'excerpt', label: 'Evidence excerpt' }, { key: 'hash', label: 'SHA-256 / hash' }, { key: 'privateNotes', label: 'Private notes' },
];

function defaultEvidenceDraft(): EvidenceDraft {
  return { claim: '', sourceType: 'url', source: '', observedAt: new Date().toISOString(), action: '', verification: '', status: 'verified', freshness: '', excerpt: '', hash: '', privateNotes: '' };
}

function evidenceYamlValue(value: string) { return JSON.stringify(value); }

function formatEvidenceReceipt(receipt: EvidenceDraft & { id?: string }) {
  const id = receipt.id || `evidence-${Date.now().toString(36)}`;
  return `\`\`\`safire-evidence\nid: ${evidenceYamlValue(id)}\nclaim: ${evidenceYamlValue(receipt.claim)}\nsource_type: ${evidenceYamlValue(receipt.sourceType)}\nsource: ${evidenceYamlValue(receipt.source)}\nobserved_at: ${evidenceYamlValue(receipt.observedAt)}\naction: ${evidenceYamlValue(receipt.action)}\nverification: ${evidenceYamlValue(receipt.verification)}\nstatus: ${evidenceYamlValue(receipt.status)}\nfreshness: ${evidenceYamlValue(receipt.freshness)}\nexcerpt: ${evidenceYamlValue(receipt.excerpt)}\nhash: ${evidenceYamlValue(receipt.hash)}\nprivate_notes: ${evidenceYamlValue(receipt.privateNotes)}\n\`\`\``;
}

function parseEvidenceReceipts(markdown: string): EvidenceReceipt[] {
  const matches = markdown.matchAll(/^\s*```safire-evidence\s*\x0d?\n([\s\S]*?)^\s*```\s*$/gim);
  const receipts: EvidenceReceipt[] = [];
  let index = 0;
  for (const match of matches) {
    const raw: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const separator = line.indexOf(':');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim(); const value = line.slice(separator + 1).trim();
      try { raw[key] = value.startsWith('"') ? String(JSON.parse(value)) : value; } catch { raw[key] = value; }
    }
    const sourceType = EVIDENCE_SOURCES.some(source => source.value === raw.source_type) ? raw.source_type as EvidenceSourceType : 'manual_observation';
    const status = EVIDENCE_STATUSES.includes(raw.status as EvidenceStatus) ? raw.status as EvidenceStatus : 'unavailable';
    const freshness = raw.freshness || ''; const expiry = Date.parse(freshness);
    if (raw.claim || raw.id) receipts.push({ id: raw.id || `evidence-${index + 1}`, claim: raw.claim || raw.label || '', sourceType, source: raw.source || '', observedAt: raw.observed_at || '', action: raw.action || '', verification: raw.verification || '', status, freshness, excerpt: raw.excerpt || '', hash: raw.hash || '', privateNotes: raw.private_notes || '', expired: Number.isFinite(expiry) && expiry <= Date.now() });
    index += 1;
  }
  return receipts;
}

function evidenceSummary(receipts: EvidenceReceipt[]) {
  return { count: receipts.length, stale: receipts.filter(receipt => receipt.status === 'stale').length, conflicting: receipts.filter(receipt => receipt.status === 'conflicting').length, expired: receipts.filter(receipt => receipt.expired).length };
}

function evidenceSearchUrl(query: string) {
  const params = new URLSearchParams(); const terms: string[] = [];
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const match = token.match(/^(status|source|after|before|from|to|state|expired):(.*)$/i);
    if (match && match[2]) params.set(match[1].toLowerCase(), match[2]); else if (/^expired$/i.test(token)) params.set('expired', 'true'); else terms.push(token);
  }
  if (terms.length) params.set('q', terms.join(' '));
  return `/api/search?${params.toString()}`;
}

function wikiToMarkdownLinks(md: string) {
  return md.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => `[${alias || target}](note:${encodeURIComponent(target.trim())})`);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] || ch));
}

function getYouTubeVideoId(href: string) {
  try {
    const url = new URL(href, window.location.href);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      if (url.searchParams.get('v')) return url.searchParams.get('v');
      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] || null;
    }
  } catch {
    return null;
  }
  return null;
}

const IMAGE_SIZES: { value: ImageSize | null; label: string; hint: string }[] = [
  { value: null, label: 'Use default', hint: 'Follow the global image setting' },
  { value: 'small', label: 'Small', hint: 'Compact image' },
  { value: 'medium', label: 'Medium', hint: 'Half-page image' },
  { value: 'large', label: 'Large', hint: 'Wide image' },
  { value: 'full', label: 'Full width', hint: 'Fit the preview column' },
  { value: 'original', label: 'Original', hint: 'Natural size' },
];
const SAFE_MARKDOWN_URI = /^(?:(?:https?|mailto|note):|\/api\/attachment(?:[/?#]|$)|#)/i;
const IMAGE_SIZE_RE = /#safire-size-(small|medium|large|full|original)$/i;
const IMAGE_MARKDOWN_RE = /(!\[[^\]\n]*\]\([^\)\n]+\))(?:\{size=(small|medium|large|full|original)\})?/gi;

function stripImageSizeHash(href: string) {
  const match = href.match(IMAGE_SIZE_RE);
  return { href: href.replace(IMAGE_SIZE_RE, ''), size: (match?.[1]?.toLowerCase() as ImageSize | undefined) || null };
}

function addImageSizeHashes(md: string) {
  return md.replace(/(!\[[^\]\n]*\]\()([^\)\n]+)(\))\{size=(small|medium|large|full|original)\}/gi, (_m, before, href, after, size) => `${before}${String(href).replace(IMAGE_SIZE_RE, '')}#safire-size-${String(size).toLowerCase()}${after}`);
}

function setMarkdownImageSize(md: string, imageIndex: number, size: ImageSize | null) {
  let current = -1;
  return md.replace(IMAGE_MARKDOWN_RE, (match, imageMarkup) => {
    current += 1;
    if (current !== imageIndex) return match;
    return size ? `${imageMarkup}{size=${size}}` : imageMarkup;
  });
}

function noteOutline(md: string): NoteOutlineItem[] {
  const items: NoteOutlineItem[] = [];
  let inFence = false;
  for (const rawLine of md.split('\n')) {
    if (/^\s*```/.test(rawLine)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = rawLine.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (!match) continue;
    const label = match[2].replace(/[`*_~]/g, '').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').trim();
    if (label) items.push({ id: `safire-heading-${items.length}`, label, depth: match[1].length });
  }
  return items;
}

function noteWordCount(md: string) {
  const readable = md.replace(/```[\s\S]*?```/g, ' ').replace(/!?(\[[^\]]*\]\([^\)]+\))/g, ' ').replace(/[#>*_`~|]/g, ' ').trim();
  return readable ? readable.split(/\s+/).length : 0;
}

function renderMarkdown(md: string) {
  const renderer = new Renderer();
  const defaultLinkRenderer = renderer.link.bind(renderer);
  const defaultCodeRenderer = renderer.code.bind(renderer);
  let imageIndex = 0;
  let headingIndex = 0;

  renderer.link = (token: Tokens.Link) => {
    const videoId = getYouTubeVideoId(token.href);
    if (!videoId) return defaultLinkRenderer(token);

    const label = renderer.parser.parseInline(token.tokens);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    const safeHref = escapeHtml(token.href);
    const safeVideoId = encodeURIComponent(videoId);
    return `<a class="youtube-link-card" href="${safeHref}" target="_blank" rel="noopener noreferrer"${title}>
      <span class="youtube-thumb-wrap"><img class="youtube-thumb" src="https://img.youtube.com/vi/${safeVideoId}/hqdefault.jpg" alt="" loading="lazy" /><span class="youtube-play">▶</span></span>
      <span class="youtube-link-copy"><span class="youtube-eyebrow">YouTube video</span><span class="youtube-title">${label}</span></span>
    </a>`;
  };

  renderer.image = (token: Tokens.Image) => {
    const index = imageIndex++;
    const parsed = stripImageSizeHash(token.href);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    const size = parsed.size ? ` data-image-size="${parsed.size}"` : '';
    return `<img class="safire-preview-image" src="${escapeHtml(parsed.href)}" alt="${escapeHtml(token.text)}" loading="lazy" data-image-index="${index}"${size}${title}>`;
  };

  renderer.code = (token: Tokens.Code) => {
    if (token.lang?.trim().toLowerCase() !== 'safire-evidence') return defaultCodeRenderer(token);
    const receipt = parseEvidenceReceipts(`\`\`\`safire-evidence\n${token.text}\n\`\`\``)[0];
    if (!receipt) return defaultCodeRenderer(token);
    const sourceLabel = EVIDENCE_SOURCES.find(source => source.value === receipt.sourceType)?.label || receipt.sourceType;
    const when = receipt.observedAt ? new Date(receipt.observedAt).toLocaleString() : 'No timestamp';
    const details = [['Source', receipt.source || 'Not recorded'], ['Observed', when], ['Action', receipt.action || 'Not recorded'], ['Verification', receipt.verification || 'Not recorded'], ['Freshness', receipt.freshness || 'Not specified'], ['Excerpt', receipt.excerpt || 'None'], ['Hash', receipt.hash || 'None'], ['Private notes', receipt.privateNotes || 'None']].map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
    const flags = `${receipt.expired ? '<span class="evidence-badge expired">expired</span>' : ''}${receipt.status === 'stale' ? '<span class="evidence-badge stale">stale</span>' : ''}${receipt.status === 'conflicting' ? '<span class="evidence-badge conflicting">conflicting</span>' : ''}`;
    return `<details class="safire-evidence-callout"><summary><span class="evidence-status ${escapeHtml(receipt.status)}">${escapeHtml(receipt.status)}</span><span class="evidence-claim">${escapeHtml(receipt.claim || 'Evidence receipt')}</span><span class="evidence-source">${escapeHtml(sourceLabel)}</span>${flags}</summary><dl>${details}</dl></details>`;
  };

  renderer.heading = (token: Tokens.Heading) => {
    const index = headingIndex++;
    const depth = Math.min(6, Math.max(1, token.depth));
    return `<h${depth} id="safire-heading-${index}" tabindex="-1">${renderer.parser.parseInline(token.tokens)}</h${depth}>`;
  };

  const rendered = marked.parse(addImageSizeHashes(wikiToMarkdownLinks(md)), { async: false, renderer }) as string;
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['class', 'data-image-index', 'data-image-size', 'loading', 'rel', 'tabindex', 'target'],
    ALLOWED_URI_REGEXP: SAFE_MARKDOWN_URI,
    FORBID_ATTR: ['style'],
    FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'math', 'object', 'script', 'style', 'svg'],
  });
}

function titleFromPath(path: string) {
  return path.split('/').pop()?.replace(/\.md$/i, '') || path;
}

function folderFromPath(path: string) {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

function FlameMark() {
  return <img className="flame-mark" src="/fire-icon.png" alt="Safire logo" />;
}

function App() {
  const [notes, setNotes] = React.useState<NoteMeta[]>([]);
  const [tree, setTree] = React.useState<TreeNode[]>([]);
  const [activePath, setActivePath] = React.useState('Welcome.md');
  const [content, setContent] = React.useState('');
  const [savedContent, setSavedContent] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<NoteMeta[]>([]);
  const [backlinks, setBacklinks] = React.useState<NoteMeta[]>([]);
  const [graph, setGraph] = React.useState<Graph>({ nodes: [], links: [] });
  const [mode, setMode] = React.useState<Mode>(() => (localStorage.getItem('safireMode') as Mode) || 'split');
  const [status, setStatus] = React.useState('Ready');
  const [vaultPath, setVaultPath] = React.useState('');
  const [tabs, setTabs] = React.useState<string[]>(() => JSON.parse(localStorage.getItem('safireTabs') || '["Welcome.md"]'));
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [quickOpen, setQuickOpen] = React.useState(false);
  const [paletteQuery, setPaletteQuery] = React.useState('');
  const [autosave, setAutosave] = React.useState(() => localStorage.getItem('safireAutosave') !== 'false');
  const [lastSavedAt, setLastSavedAt] = React.useState<number | null>(null);
  const [dialog, setDialog] = React.useState<SafireDialog | null>(null);
  const [settings, setSettings] = React.useState<SafireSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [backupsOpen, setBackupsOpen] = React.useState(false);
  const [backups, setBackups] = React.useState<BackupItem[]>([]);
  const [backupPreview, setBackupPreview] = React.useState<{ item: BackupItem; content: string } | null>(null);
  const [health, setHealth] = React.useState<VaultHealth | null>(null);
  const [workspaceState, setWorkspaceState] = React.useState<WorkspaceState>({ pinnedNotes: [], recentNotes: [], savedSearches: [] });
  const [tasks, setTasks] = React.useState<VaultTask[]>([]);
  const [templates, setTemplates] = React.useState<TemplateItem[]>([]);
  const [workspaceView, setWorkspaceView] = React.useState<WorkspaceView>('note');
  const [taskState, setTaskState] = React.useState<'open'|'completed'>('open');
  const [quickCaptureOpen, setQuickCaptureOpen] = React.useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = React.useState(false);
  const [webClipperOpen, setWebClipperOpen] = React.useState(false);
  const [webClipTemplates, setWebClipTemplates] = React.useState<WebClipTemplate[]>([]);
  const [attachmentViewer, setAttachmentViewer] = React.useState<AttachmentViewerState | null>(null);
  const [imageResizeMenu, setImageResizeMenu] = React.useState<ImageResizeMenuState | null>(null);
  const [graphPanel, setGraphPanel] = React.useState<GraphPanel | null>(null);
  const [evidenceComposerOpen, setEvidenceComposerOpen] = React.useState(false);
  const [evidencePanelOpen, setEvidencePanelOpen] = React.useState(false);
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const dirty = content !== savedContent;
  const activeMeta = notes.find(n => n.path === activePath);
  const evidenceReceipts = React.useMemo(() => parseEvidenceReceipts(content), [content]);
  const evidence = React.useMemo(() => evidenceSummary(evidenceReceipts), [evidenceReceipts]);

  const askInput = React.useCallback((options: Omit<Extract<SafireDialog, { kind: 'input' }>, 'kind' | 'resolve'>) => {
    return new Promise<string | null>((resolve) => setDialog({ kind: 'input', ...options, resolve }));
  }, []);

  const askConfirm = React.useCallback((options: Omit<Extract<SafireDialog, { kind: 'confirm' }>, 'kind' | 'resolve'>) => {
    return new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', ...options, resolve }));
  }, []);


  const loadIndex = React.useCallback(async () => {
    const [notesData, treeData, graphData] = await Promise.all([
      api<{ vault: string; notes: NoteMeta[] }>('/api/notes'),
      api<{ vault: string; tree: TreeNode[] }>('/api/tree'),
      api<Graph>('/api/graph'),
    ]);
    setNotes(notesData.notes);
    setTree(treeData.tree);
    setVaultPath(notesData.vault);
    setGraph(graphData);
  }, []);

  const loadSettings = React.useCallback(async () => {
    const data = await api<{ settings: SafireSettings }>('/api/settings');
    setSettings(data.settings);
    setAutosave(data.settings.autosave);
    setMode(data.settings.defaultMode);
    return data.settings;
  }, []);

  const loadBackups = React.useCallback(async (path = activePath) => {
    const data = await api<{ backups: BackupItem[] }>(`/api/backups?path=${encodeURIComponent(path)}`);
    setBackups(data.backups);
    setBackupPreview(null);
    return data.backups;
  }, [activePath]);

  const loadHealth = React.useCallback(async () => {
    const data = await api<VaultHealth>('/api/vault-health');
    setHealth(data);
    return data;
  }, []);

  const loadWorkspace = React.useCallback(async () => {
    const data = await api<WorkspaceState>('/api/workspace');
    setWorkspaceState(data);
    return data;
  }, []);

  const loadTasks = React.useCallback(async (state: 'open'|'completed' = taskState) => {
    const data = await api<{ tasks: VaultTask[] }>(`/api/tasks?state=${state}`);
    setTasks(data.tasks);
    return data.tasks;
  }, [taskState]);

  const loadTemplates = React.useCallback(async () => {
    const data = await api<{ templates: TemplateItem[] }>('/api/templates');
    setTemplates(data.templates);
    return data.templates;
  }, []);

  const loadWebClipTemplates = React.useCallback(async () => {
    const data = await api<{ templates: WebClipTemplate[] }>('/api/web-clip/templates');
    setWebClipTemplates(data.templates);
    return data.templates;
  }, []);

  const loadBacklinks = React.useCallback(async (path: string) => {
    const data = await api<{ backlinks: NoteMeta[] }>(`/api/backlinks?path=${encodeURIComponent(path)}`);
    setBacklinks(data.backlinks);
  }, []);

  const openNote = React.useCallback(async (path: string, addTab = true) => {
    const normalized = path.endsWith('.md') ? path : `${path}.md`;
    const data = await api<{ path: string; content: string }>(`/api/note?path=${encodeURIComponent(normalized)}`);
    setActivePath(data.path);
    setContent(data.content);
    setSavedContent(data.content);
    if (addTab) setTabs(prev => prev.includes(data.path) ? prev : [...prev, data.path]);
    await loadBacklinks(data.path);
    api<WorkspaceState>('/api/workspace/recent', { method: 'POST', body: JSON.stringify({ path: data.path }) }).then(setWorkspaceState).catch(() => null);
    setStatus(`Opened ${data.path}`);
  }, [loadBacklinks]);

  const openGraphPanel = React.useCallback(async (path: string, panelMode: GraphPanel['mode']) => {
    if (activePath === path) {
      setGraphPanel({ mode: panelMode });
      return;
    }
    if (dirty) {
      const proceed = await askConfirm({ title: 'Leave unsaved graph note?', message: `Your changes to "${titleFromPath(activePath)}" have not been saved. Open another note anyway?`, confirmLabel: 'Open note', danger: true });
      if (!proceed) return;
    }
    await openNote(path);
    setGraphPanel({ mode: panelMode });
  }, [activePath, askConfirm, dirty, openNote]);

  const createMissingGraphNote = React.useCallback(async (title: string) => {
    if (dirty) {
      const proceed = await askConfirm({ title: 'Leave unsaved graph note?', message: `Your changes to "${titleFromPath(activePath)}" have not been saved. Create and open "${title}" anyway?`, confirmLabel: 'Create note', danger: true });
      if (!proceed) return;
    }
    const data = await api<{ path: string }>('/api/note', { method: 'POST', body: JSON.stringify({ title }) });
    await loadIndex();
    await openNote(data.path);
    setGraphPanel({ mode: 'edit' });
    setStatus(`Created ${data.path} from the graph`);
  }, [activePath, askConfirm, dirty, loadIndex, openNote]);

  React.useEffect(() => {
    (async () => {
      const appSettings = await loadSettings();
      document.documentElement.dataset.theme = appSettings.theme;
      document.documentElement.style.colorScheme = appSettings.theme;
      await loadIndex();
      await openNote(appSettings.startupNote || activePath).catch(() => openNote(activePath));
      await Promise.all([loadHealth().catch(() => null), loadWorkspace().catch(() => null), loadTasks('open').catch(() => null), loadTemplates().catch(() => null), loadWebClipTemplates().catch(() => null)]);
    })().catch(e => setStatus(e.message));
  }, []);
  React.useEffect(() => {
    const theme = settings?.theme || 'dark';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [settings?.theme]);
  React.useEffect(() => { localStorage.setItem('safireTabs', JSON.stringify(tabs)); }, [tabs]);
  React.useEffect(() => { localStorage.setItem('safireMode', mode); }, [mode]);
  React.useEffect(() => { localStorage.setItem('safireAutosave', String(autosave)); }, [autosave]);

  React.useEffect(() => {
    const t = setTimeout(async () => {
      if (!query.trim()) return setSearchResults([]);
      const data = await api<{ results: NoteMeta[] }>(evidenceSearchUrl(query));
      setSearchResults(data.results);
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  const save = React.useCallback(async () => {
    await api('/api/note', { method: 'PUT', body: JSON.stringify({ path: activePath, content }) });
    setSavedContent(content);
    setLastSavedAt(Date.now());
    await loadIndex();
    await loadBacklinks(activePath);
    setStatus(`Saved ${activePath}`);
  }, [activePath, content, loadBacklinks, loadIndex]);

  React.useEffect(() => {
    if (!autosave || !dirty) return;
    const t = setTimeout(() => save().catch(e => setStatus(e.message)), settings?.autosaveDelay ?? 900);
    return () => clearTimeout(t);
  }, [autosave, dirty, content, save, settings?.autosaveDelay]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save().catch(err => setStatus(err.message)); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); setPaletteQuery(''); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); setQuickOpen(true); setPaletteQuery(''); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); setEvidenceComposerOpen(true); }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setQuickOpen(false);
        setAttachmentViewer(null);
        setImageResizeMenu(null);
        setGraphPanel(null);
        if (dialog) {
          if (dialog.kind === 'confirm') dialog.resolve(false);
          else dialog.resolve(null);
          setDialog(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, dialog]);

  const createNote = async (prefill?: string) => {
    const title = prefill ?? await askInput({
      title: 'New note',
      message: 'Name the note, or include a folder path such as Projects/Safire Ideas.',
      defaultValue: folderFromPath(activePath) ? `${folderFromPath(activePath)}/Untitled` : 'Untitled',
      placeholder: 'Note name or folder/path',
      confirmLabel: 'Create note',
    });
    if (!title?.trim()) return;
    const data = await api<{ path: string }>('/api/note', { method: 'POST', body: JSON.stringify({ title: title.trim() }) });
    await loadIndex();
    await openNote(data.path);
  };

  const createFolder = async () => {
    const name = await askInput({
      title: 'New folder',
      message: 'Create a folder inside the Safire vault.',
      defaultValue: folderFromPath(activePath) || 'New Folder',
      placeholder: 'Folder name or path',
      confirmLabel: 'Create folder',
    });
    if (!name?.trim()) return;
    await api('/api/folder', { method: 'POST', body: JSON.stringify({ path: name.trim() }) });
    await loadIndex();
    setStatus(`Created folder ${name.trim()}`);
  };

  const openDaily = async () => {
    const data = await api<{ path: string }>('/api/daily', { method: 'POST' });
    await loadIndex();
    await openNote(data.path);
  };

  const renameActive = async () => {
    const to = await askInput({
      title: 'Rename or move note',
      message: 'Change the note path. Include folders if you want to move it.',
      defaultValue: activePath,
      placeholder: 'New note path',
      confirmLabel: 'Rename note',
    });
    if (!to?.trim() || to.trim() === activePath) return;
    const data = await api<{ to: string }>('/api/rename', { method: 'POST', body: JSON.stringify({ from: activePath, to: to.trim() }) });
    setTabs(prev => prev.map(t => t === activePath ? data.to : t));
    await loadIndex();
    await openNote(data.to);
  };

  const deleteNote = async () => {
    const ok = await askConfirm({
      title: 'Delete note?',
      message: `Delete ${activePath}? A backup copy will be made first.`,
      confirmLabel: 'Delete note',
      danger: true,
    });
    if (!ok) return;
    await api('/api/note', { method: 'DELETE', body: JSON.stringify({ path: activePath }) });
    const remaining = notes.filter(n => n.path !== activePath);
    const next = remaining[0]?.path || 'Welcome.md';
    setTabs(prev => prev.filter(t => t !== activePath));
    await loadIndex();
    await openNote(next).catch(() => setStatus('Deleted note. Create a new note to continue.'));
  };

  const insertMarkdown = (before: string, after = '', placeholder = 'text') => {
    const el = editorRef.current;
    const start = el?.selectionStart ?? content.length;
    const end = el?.selectionEnd ?? content.length;
    const selected = content.slice(start, end) || placeholder;
    const next = content.slice(0, start) + before + selected + after + content.slice(end);
    setContent(next);
    setTimeout(() => {
      editorRef.current?.focus();
      const cursorStart = start + before.length;
      const cursorEnd = cursorStart + selected.length;
      editorRef.current?.setSelectionRange(cursorStart, cursorEnd);
    }, 0);
  };

  const insertAtCursor = (text: string) => {
    const el = editorRef.current;
    const start = el?.selectionStart ?? content.length;
    const end = el?.selectionEnd ?? content.length;
    const next = content.slice(0, start) + text + content.slice(end);
    setContent(next);
    setTimeout(() => { editorRef.current?.focus(); editorRef.current?.setSelectionRange(start + text.length, start + text.length); }, 0);
  };

  const insertEvidenceReceipt = (draft: EvidenceDraft) => {
    const spacer = content && !content.endsWith('\n') ? '\n\n' : '\n';
    insertAtCursor(`${spacer}${formatEvidenceReceipt(draft)}\n`);
    setEvidenceComposerOpen(false);
    setStatus('Inserted a local evidence receipt');
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    const cursor = event.currentTarget.selectionStart;
    const lineStart = content.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
    if (!['/evidence', '/receipt'].includes(content.slice(lineStart, cursor).trim().toLowerCase())) return;
    event.preventDefault();
    setContent(`${content.slice(0, lineStart)}${content.slice(cursor)}`);
    setEvidenceComposerOpen(true);
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setStatus(`Attaching ${list.length} file${list.length === 1 ? '' : 's'}...`);
    for (const file of list) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const uploaded = await api<{ markdown: string; path: string; size: number }>('/api/attachment', { method: 'POST', body: JSON.stringify({ filename: file.name, data }) });
      insertAtCursor(`\n${uploaded.markdown}\n`);
      setStatus(`Attached ${uploaded.path}`);
    }
    await loadIndex();
  };

  const openBackups = async () => {
    await loadBackups(activePath);
    setBackupsOpen(true);
  };

  const previewBackup = async (item: BackupItem) => {
    const data = await api<{ content: string }>(`/api/backup?id=${encodeURIComponent(item.id)}`);
    setBackupPreview({ item, content: data.content });
  };

  const restoreBackup = async (item: BackupItem) => {
    const ok = await askConfirm({ title: 'Restore backup?', message: `Replace ${activePath} with this backup? Safire will create a safety backup first.`, confirmLabel: 'Restore backup', danger: true });
    if (!ok) return;
    const data = await api<{ path: string }>('/api/backup/restore', { method: 'POST', body: JSON.stringify({ id: item.id, path: activePath }) });
    await loadIndex();
    await openNote(data.path, false);
    await loadBackups(data.path);
    setStatus(`Restored ${data.path} from backup`);
  };

  const saveSettings = async (next: SafireSettings) => {
    const data = await api<{ settings: SafireSettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(next) });
    setSettings(data.settings);
    setAutosave(data.settings.autosave);
    setMode(data.settings.defaultMode);
    setStatus('Settings saved');
  };

  const toggleTask = async (task: VaultTask) => {
    await api('/api/task/toggle', { method: 'POST', body: JSON.stringify({ path: task.path, line: task.line }) });
    await Promise.all([loadTasks(taskState), loadIndex(), loadHealth()]);
    if (task.path === activePath) await openNote(activePath, false);
    setStatus(`${task.completed ? 'Reopened' : 'Completed'} task`);
  };

  const togglePin = async () => {
    const pinned = workspaceState.pinnedNotes.includes(activePath);
    const next = await api<WorkspaceState>('/api/workspace/pin', { method: pinned ? 'DELETE' : 'POST', body: JSON.stringify({ path: activePath }) });
    setWorkspaceState(next);
    setStatus(pinned ? 'Note unpinned' : 'Note pinned');
  };

  const capture = async (text: string, tag: string) => {
    const data = await api<{ path: string }>('/api/capture', { method: 'POST', body: JSON.stringify({ text, tag }) });
    await Promise.all([loadIndex(), loadWorkspace(), loadTasks(taskState), loadHealth()]);
    await openNote(data.path);
    setQuickCaptureOpen(false);
    setWorkspaceView('note');
    setStatus('Captured to Inbox');
  };

  const clipWebPage = async (url: string, templateId: string, title: string) => {
    setStatus('Reading page and building an offline Markdown clip…');
    const data = await api<{ path: string; title: string }>('/api/web-clip', { method: 'POST', body: JSON.stringify({ url, templateId, title }) });
    await Promise.all([loadIndex(), loadHealth(), loadWebClipTemplates()]);
    await openNote(data.path);
    setWebClipperOpen(false);
    setWorkspaceView('note');
    setStatus(`Saved ${data.title} for offline reading`);
  };

  const saveWebClipTemplate = async (template: Omit<WebClipTemplate, 'body'> & { body: string }) => {
    await api('/api/web-clip/templates', { method: 'POST', body: JSON.stringify(template) });
    await loadWebClipTemplates();
    setStatus(`Saved ${template.name} web clip template`);
  };

  const instantiateTemplate = async (templatePath: string, destination: string, title: string) => {
    const data = await api<{ path: string }>('/api/template/instantiate', { method: 'POST', body: JSON.stringify({ templatePath, destination, title }) });
    await Promise.all([loadIndex(), loadTemplates(), loadTasks(taskState)]);
    await openNote(data.path);
    setTemplatePickerOpen(false);
    setWorkspaceView('note');
  };

  const saveSearch = async () => {
    if (!query.trim()) return;
    const name = await askInput({ title: 'Save search', message: 'Give this search a short name.', defaultValue: query.trim(), confirmLabel: 'Save search' });
    if (!name) return;
    setWorkspaceState(await api<WorkspaceState>('/api/workspace/search', { method: 'POST', body: JSON.stringify({ name, query: query.trim() }) }));
    setStatus('Saved search');
  };

  const removeSavedSearch = async (id: string) => setWorkspaceState(await api<WorkspaceState>(`/api/workspace/search/${encodeURIComponent(id)}`, { method: 'DELETE' }));

  const applyImageSize = (imageIndex: number, size: ImageSize | null) => {
    setContent(prev => setMarkdownImageSize(prev, imageIndex, size));
    setImageResizeMenu(null);
    setStatus(size ? `Image size set to ${size === 'full' ? 'full width' : size}` : 'Image size set to default');
  };

  const openAttachmentInSafire = (href: string) => {
    const url = new URL(href, window.location.href);
    const filePath = url.searchParams.get('path') || 'Attachment';
    const name = filePath.split('/').pop() || filePath;
    const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(filePath);
    const isText = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|xml|html?|css|js|ts|tsx|jsx|py|yml|yaml|toml|ini)$/i.test(filePath);
    setAttachmentViewer({ url: `${url.pathname}${url.search}`, name, kind: isImage ? 'image' : isText ? 'text' : 'document' });
    setStatus(`Viewing attachment ${filePath} — use Back to Safire when done`);
  };

  const closeTab = async (path: string) => {
    const nextTabs = tabs.filter(t => t !== path);
    setTabs(nextTabs.length ? nextTabs : [activePath]);
    if (path === activePath && nextTabs[0]) await openNote(nextTabs[0], false);
  };

  const openWikiTarget = async (target: string) => {
    const direct = target.endsWith('.md') ? target : `${target}.md`;
    const found = notes.find(n => n.path.toLowerCase() === direct.toLowerCase() || n.title.toLowerCase() === target.toLowerCase());
    if (!found) {
      const ok = await askConfirm({ title: 'Create linked note?', message: `Create note "${target}"?`, confirmLabel: 'Create note' });
      if (!ok) return;
      await api('/api/note', { method: 'POST', body: JSON.stringify({ title: target }) });
      await loadIndex();
    }
    await openNote(found?.path || direct);
  };

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const image = target.closest('img.safire-preview-image') as HTMLImageElement | null;
      if (image?.dataset.imageIndex) {
        e.preventDefault();
        const rect = image.getBoundingClientRect();
        setImageResizeMenu({
          index: Number(image.dataset.imageIndex),
          x: Math.min(e.clientX || rect.left + 20, window.innerWidth - 220),
          y: Math.min(e.clientY || rect.top + 20, window.innerHeight - 270),
          alt: image.alt || 'Image',
          src: image.currentSrc || image.src,
          size: (image.dataset.imageSize as ImageSize | undefined) || null,
        });
        return;
      }
      const a = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (href.startsWith('note:')) {
        e.preventDefault();
        openWikiTarget(decodeURIComponent(href.replace('note:', ''))).catch(err => setStatus(err.message));
        return;
      }
      const url = new URL(href, window.location.href);
      if (url.origin === window.location.origin && url.pathname === '/api/attachment') {
        e.preventDefault();
        openAttachmentInSafire(href);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  });

  const rendered = React.useMemo(() => ({ __html: renderMarkdown(content) }), [content]);
  const allTags = React.useMemo(() => [...new Set(notes.flatMap(n => n.tags))].sort(), [notes]);
  const outline = React.useMemo(() => noteOutline(content), [content]);
  const wordCount = React.useMemo(() => noteWordCount(content), [content]);
  const readingMinutes = Math.max(1, Math.ceil(wordCount / 220));
  const goToHeading = (id: string) => {
    if (workspaceView !== 'note') setWorkspaceView('note');
    if (mode === 'graph') setMode('preview');
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const commands = [
    { name: 'Home', hint: 'Open your practical Safire dashboard', run: () => setWorkspaceView('home') },
    { name: 'Tasks', hint: 'Review Markdown tasks across the vault', run: () => { setWorkspaceView('tasks'); loadTasks(taskState); } },
    { name: 'Quick capture', hint: 'Capture a thought to Inbox', run: () => setQuickCaptureOpen(true) },
    { name: 'Clip web page', hint: 'Save an article, recipe, reference, or paper as offline Markdown', run: () => setWebClipperOpen(true) },
    { name: 'New from template', hint: 'Create a note from Templates', run: () => setTemplatePickerOpen(true) },
    { name: 'New note', hint: 'Create a Markdown note', run: () => createNote() },
    { name: 'Insert evidence receipt', hint: 'Ctrl/Cmd+Shift+E · portable local Markdown', run: () => setEvidenceComposerOpen(true) },
    { name: 'Evidence for active note', hint: 'Review, redact, copy, or export selected receipts', run: () => setEvidencePanelOpen(true) },
    { name: 'New folder', hint: 'Create a vault folder', run: createFolder },
    { name: 'Open daily note', hint: 'Create/open today in Daily Notes', run: openDaily },
    { name: 'Save note', hint: 'Ctrl+S', run: () => save() },
    { name: autosave ? 'Turn autosave off' : 'Turn autosave on', hint: 'Toggle autosave', run: () => setAutosave(v => !v) },
    { name: 'Rename/move active note', hint: 'Change file path', run: renameActive },
    { name: 'Attach file', hint: 'Copy a file into the vault and insert a Markdown link', run: () => fileInputRef.current?.click() },
    { name: 'Backups for active note', hint: 'Preview or restore previous saved versions', run: openBackups },
    { name: 'Settings', hint: 'Autosave, startup note, backup retention', run: () => setSettingsOpen(true) },
    { name: 'Toggle graph view', hint: 'Show graph canvas', run: () => setMode(mode === 'graph' ? 'split' : 'graph') },
    { name: 'Split view', hint: 'Editor + preview', run: () => setMode('split') },
    { name: 'Preview only', hint: 'Rendered Markdown', run: () => setMode('preview') },
    { name: 'Edit only', hint: 'Markdown editor', run: () => setMode('edit') },
  ];

  return <div className="app-shell">
    <aside className="ribbon">
      <button title="Home" onClick={() => setWorkspaceView('home')}>⌂</button><button title="Tasks" onClick={() => { setWorkspaceView('tasks'); loadTasks(taskState); }}>☑</button><button title="Quick capture" onClick={() => setQuickCaptureOpen(true)}>＋</button><button title="Web clipper" onClick={() => setWebClipperOpen(true)}>◫</button><button title="Files" onClick={() => setWorkspaceView('note')}>▤</button><button title="Search" onClick={() => setQuickOpen(true)}>⌕</button><button title="Graph" onClick={() => { setWorkspaceView('note'); setMode('graph'); }}>◎</button><button title="Backups" onClick={openBackups}>↶</button><button title="Settings" onClick={() => setSettingsOpen(true)}>⚙</button><button title="Commands" onClick={() => setPaletteOpen(true)}>⌘</button>
    </aside>
    <aside className="sidebar">
      <div className="brand"><div className="brand-logo"><FlameMark /></div><div className="brand-copy"><h1 className="brand-wordmark"><span className="brand-name">Safire</span><span className="app-version">v{APP_VERSION}</span></h1><p>Local-first knowledge forge</p></div></div>
      <div className="toolbar-row"><button className="primary" onClick={() => createNote()}>+ Note</button><button onClick={createFolder}>+ Folder</button><button onClick={openDaily}>Today</button></div>
      <input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search · status:verified source:url expired" />
      {query.trim() && <button className="save-search" onClick={saveSearch}>Save search</button>}
      <div className="vault-path" title={vaultPath}>{vaultPath}</div>
      {query.trim() && <section><h2>Search</h2>{searchResults.map(n => <button className="note-row search-hit" key={n.path} onClick={() => openNote(n.path)}><b>{n.title}</b><span>{n.path} — {n.excerpt}</span></button>)}</section>}
      <section><h2>Files</h2><FileTree nodes={tree} activePath={activePath} openNote={openNote} /></section>
      <section><h2>Tags</h2><div className="tag-cloud">{allTags.map(t => <button key={t} onClick={() => setQuery('#'+t)}>#{t}</button>)}</div></section>
    </aside>

    <main className="workspace">
      {workspaceView === 'home' ? <HomeView notes={notes} tasks={tasks} workspace={workspaceState} health={health} openNote={(path) => { setWorkspaceView('note'); openNote(path); }} openDaily={() => { setWorkspaceView('note'); openDaily(); }} capture={() => setQuickCaptureOpen(true)} templates={() => setTemplatePickerOpen(true)} showTasks={() => { setWorkspaceView('tasks'); loadTasks(taskState); }} runSearch={(value) => { setQuery(value); setWorkspaceView('note'); }} removeSearch={removeSavedSearch} toggleTask={toggleTask} /> : workspaceView === 'tasks' ? <TasksView tasks={tasks} state={taskState} setState={(next) => { setTaskState(next); loadTasks(next); }} openNote={(path) => { setWorkspaceView('note'); openNote(path); }} toggleTask={toggleTask} /> : <>
        <div className="tabs">{tabs.map(t => <button key={t} className={t===activePath?'active':''} onClick={() => openNote(t, false)}><span>{titleFromPath(t)}</span><i onClick={(e) => { e.stopPropagation(); closeTab(t); }}>×</i></button>)}</div>
        <header className="topbar">
          <div><div className="crumb">{activePath}</div><h2>{activeMeta?.title || activePath}{dirty ? ' •' : ''}</h2><p>{autosave ? 'Autosave on' : 'Autosave off'}{lastSavedAt ? ` · saved ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}</p></div>
          <div className="actions"><button onClick={() => setMode('split')} className={mode==='split'?'on':''}>Split</button><button onClick={() => setMode('edit')} className={mode==='edit'?'on':''}>Edit</button><button onClick={() => setMode('preview')} className={mode==='preview'?'on':''}>Preview</button><button onClick={() => setMode('graph')} className={mode==='graph'?'on':''}>Graph</button><button onClick={() => setEvidenceComposerOpen(true)}>Evidence</button><button onClick={togglePin}>{workspaceState.pinnedNotes.includes(activePath) ? 'Unpin' : 'Pin'}</button><button onClick={() => fileInputRef.current?.click()}>Attach</button><button onClick={openBackups}>Backups</button><button onClick={() => setSettingsOpen(true)}>Settings</button><button onClick={renameActive}>Rename</button><button onClick={save} disabled={!dirty}>Save</button><button className="danger" onClick={deleteNote}>Delete</button></div>
        </header>
        {mode !== 'graph' && (mode==='split'||mode==='edit') && <MarkdownToolbar insert={insertMarkdown} attach={() => fileInputRef.current?.click()} evidence={() => setEvidenceComposerOpen(true)} />}
        {mode !== 'graph' ? <div className={'panes '+mode} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); uploadFiles(e.dataTransfer.files).catch(err => setStatus(err.message)); }}>{(mode==='split'||mode==='edit') && <textarea ref={editorRef} className="editor" spellCheck="true" value={content} onChange={e => setContent(e.target.value)} onKeyDown={handleEditorKeyDown} onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); uploadFiles(e.clipboardData.files).catch(err => setStatus(err.message)); } }} />}{(mode==='split'||mode==='preview') && <article className={`preview markdown ${settings?.fitImagesToPage === false ? '' : 'fit-images'}`} dangerouslySetInnerHTML={rendered} />}</div> : <GraphView graph={graph} activePath={activePath} onPreview={(path) => openGraphPanel(path, 'preview')} onEdit={(path) => openGraphPanel(path, 'edit')} onCreateMissing={createMissingGraphNote} overlay={graphPanel && <GraphNotePanel mode={graphPanel.mode} path={activePath} content={content} dirty={dirty} close={() => setGraphPanel(null)} setMode={(panelMode) => setGraphPanel({ mode: panelMode })} save={() => save().catch(err => setStatus(err.message))} setContent={setContent} />} />}
      </>}
    </main>

    <aside className="inspector"><section className="note-overview"><h2>Note overview</h2><div className="note-stats"><span><b>{wordCount.toLocaleString()}</b> words</span><span><b>{readingMinutes} min</b> read</span></div>{outline.length ? <nav className="note-outline" aria-label="Note outline">{outline.map(item => <button key={item.id} style={{ paddingLeft: `${10 + (item.depth - 1) * 13}px` }} title={item.label} onClick={() => goToHeading(item.id)}><span>H{item.depth}</span><b>{item.label}</b></button>)}</nav> : <p className="empty">Add Markdown headings to create a quick outline.</p>}</section><section className="evidence-overview"><div><h2>Evidence</h2><button onClick={() => setEvidencePanelOpen(true)}>{evidence.count ? 'Review' : 'Add'}</button></div><p><b>{evidence.count}</b> receipt{evidence.count === 1 ? '' : 's'}</p>{(evidence.stale || evidence.expired || evidence.conflicting) ? <div className="evidence-badges">{evidence.stale ? <span className="evidence-badge stale">{evidence.stale} stale</span> : null}{evidence.expired ? <span className="evidence-badge expired">{evidence.expired} expired</span> : null}{evidence.conflicting ? <span className="evidence-badge conflicting">{evidence.conflicting} conflicting</span> : null}</div> : <p className="small">No stale, expired, or conflicting evidence.</p>}</section><h2>Backlinks</h2>{backlinks.length ? backlinks.map(b => <button className="backlink" key={b.path} onClick={() => openNote(b.path)}><b>{b.title}</b><span>{b.path} — {b.excerpt}</span></button>) : <p className="empty">No backlinks yet. Link here with [[{activeMeta?.title || 'Note'}]].</p>}<h2>Outgoing links</h2><div className="link-list">{activeMeta?.links?.map(l => <button key={l} onClick={() => openWikiTarget(l)}>[[{l}]]</button>) || null}</div><h2>Properties</h2><p className="small">Path: {activePath}</p><p className="small">Tags: {activeMeta?.tags.map(t => '#'+t).join(' ') || 'none'}</p><p className="small">Status: {status}</p>{health && <><h2>Vault health</h2><p className="small">{health.noteCount} notes · {health.tagCount} tags · {health.linkCount} links</p><p className="small">{health.missingLinks.length} missing links · {health.orphanNotes.length} orphan notes · {health.backupCount} backups</p></>}<p className="small">Shortcuts: Ctrl+K commands · Ctrl+O quick switcher · Ctrl+S save · Ctrl/Cmd+Shift+E evidence</p></aside>

    <input ref={fileInputRef} className="hidden-file" type="file" multiple onChange={e => { if (e.target.files) uploadFiles(e.target.files).catch(err => setStatus(err.message)); e.currentTarget.value = ''; }} />
    {dialog && <SafireModal dialog={dialog} close={() => { if (dialog.kind === 'confirm') (dialog.resolve as (value: boolean) => void)(false); else (dialog.resolve as (value: string | null) => void)(null); setDialog(null); }} done={(value) => { if (dialog.kind === 'confirm') (dialog.resolve as (value: boolean) => void)(value as boolean); else (dialog.resolve as (value: string | null) => void)(value as string | null); setDialog(null); }} />}
    {settingsOpen && settings && <SettingsPanel settings={settings} close={() => setSettingsOpen(false)} save={saveSettings} />}
    {imageResizeMenu && <ImageResizeMenu menu={imageResizeMenu} apply={applyImageSize} close={() => setImageResizeMenu(null)} />}
    {attachmentViewer && <AttachmentViewer viewer={attachmentViewer} close={() => setAttachmentViewer(null)} />}
    {backupsOpen && <BackupsPanel activePath={activePath} backups={backups} preview={backupPreview} close={() => setBackupsOpen(false)} refresh={() => loadBackups(activePath)} show={previewBackup} restore={restoreBackup} />}
    {quickCaptureOpen && <QuickCapturePanel close={() => setQuickCaptureOpen(false)} capture={capture} />}
    {templatePickerOpen && <TemplatePicker templates={templates} close={() => setTemplatePickerOpen(false)} create={instantiateTemplate} />}
    {webClipperOpen && <WebClipperPanel templates={webClipTemplates} close={() => setWebClipperOpen(false)} clip={clipWebPage} saveTemplate={saveWebClipTemplate} />}

    {evidenceComposerOpen && <EvidenceComposer close={() => setEvidenceComposerOpen(false)} insert={insertEvidenceReceipt} />}
    {evidencePanelOpen && <EvidencePanel receipts={evidenceReceipts} close={() => setEvidencePanelOpen(false)} add={() => { setEvidencePanelOpen(false); setEvidenceComposerOpen(true); }} />}
    {paletteOpen && <Palette title="Command palette" query={paletteQuery} setQuery={setPaletteQuery} close={() => setPaletteOpen(false)} items={commands.map(c => ({ label: c.name, sub: c.hint, run: async () => { await c.run(); setPaletteOpen(false); } }))} />}
    {quickOpen && <Palette title="Quick switcher" query={paletteQuery} setQuery={setPaletteQuery} close={() => setQuickOpen(false)} items={notes.map(n => ({ label: n.title, sub: n.path, run: async () => { await openNote(n.path); setQuickOpen(false); } }))} />}
  </div>;
}

function HomeView({ notes, tasks, workspace, health, openNote, openDaily, capture, templates, showTasks, runSearch, removeSearch, toggleTask }: { notes: NoteMeta[]; tasks: VaultTask[]; workspace: WorkspaceState; health: VaultHealth | null; openNote: (path: string) => void; openDaily: () => void; capture: () => void; templates: () => void; showTasks: () => void; runSearch: (query: string) => void; removeSearch: (id: string) => void; toggleTask: (task: VaultTask) => void }) {
  const byPath = new Map(notes.map(note => [note.path, note]));
  const pins = workspace.pinnedNotes.map(path => byPath.get(path)).filter((note): note is NoteMeta => Boolean(note));
  const recents = workspace.recentNotes.map(item => ({ ...item, note: byPath.get(item.path) })).filter((item): item is { path: string; openedAt: number; note: NoteMeta } => Boolean(item.note));
  return <div className="home-view"><header className="home-header"><div><span>Safire workspace</span><h2>Home</h2><p>Pick up the next useful thing without leaving your vault.</p></div><button onClick={showTasks} className="primary-action">{tasks.length} open tasks</button></header><div className="home-grid"><section className="home-card home-start"><h3>Start here</h3><div className="home-actions"><button onClick={openDaily}>Open today’s note</button><button onClick={capture}>Quick capture</button><button onClick={templates}>New from template</button></div></section><section className="home-card"><div className="home-card-head"><h3>Open tasks</h3><button onClick={showTasks}>View all</button></div>{tasks.length ? tasks.slice(0, 8).map(task => <div className="home-task" key={task.id}><button aria-label={`Complete ${task.text}`} onClick={() => toggleTask(task)}>☐</button><button onClick={() => openNote(task.path)}><b>{task.text}</b><span>{task.path}</span></button></div>) : <p className="empty-home">No open Markdown tasks.</p>}</section><section className="home-card"><h3>Pinned</h3>{pins.length ? pins.map(note => <button className="home-note" key={note.path} onClick={() => openNote(note.path)}><b>{note.title}</b><span>{note.path}</span></button>) : <p className="empty-home">Pin a note from its header to keep it here.</p>}</section><section className="home-card"><h3>Recent</h3>{recents.length ? recents.map(item => <button className="home-note" key={item.path} onClick={() => openNote(item.path)}><b>{item.note.title}</b><span>{item.path} · {relativeTime(item.openedAt)}</span></button>) : <p className="empty-home">Open notes to build your recent trail.</p>}</section><section className="home-card"><h3>Saved searches</h3>{workspace.savedSearches.length ? workspace.savedSearches.map(search => <div className="saved-search-row" key={search.id}><button onClick={() => runSearch(search.query)}><b>{search.name}</b><span>{search.query}</span></button><button aria-label={`Remove ${search.name}`} onClick={() => removeSearch(search.id)}>×</button></div>) : <p className="empty-home">Save a sidebar search to reuse it here.</p>}</section><section className="home-card"><h3>Vault health</h3>{health ? <p className="health-line"><b>{health.noteCount}</b> notes · <b>{health.linkCount}</b> links<br />{health.missingLinks.length} unresolved · {health.orphanNotes.length} orphan notes</p> : <p className="empty-home">Loading health…</p>}</section></div></div>;
}

function TasksView({ tasks, state, setState, openNote, toggleTask }: { tasks: VaultTask[]; state: 'open'|'completed'; setState: (state: 'open'|'completed') => void; openNote: (path: string) => void; toggleTask: (task: VaultTask) => void }) {
  return <div className="home-view tasks-view"><header className="home-header"><div><span>Vault-wide Markdown</span><h2>Tasks</h2><p>{tasks.length} {state} task{tasks.length === 1 ? '' : 's'}.</p></div><div className="task-tabs"><button className={state === 'open' ? 'on' : ''} onClick={() => setState('open')}>Open</button><button className={state === 'completed' ? 'on' : ''} onClick={() => setState('completed')}>Completed</button></div></header><section className="home-card task-list">{tasks.length ? tasks.map(task => <div className="home-task" key={task.id}><button aria-label={`${task.completed ? 'Reopen' : 'Complete'} ${task.text}`} onClick={() => toggleTask(task)}>{task.completed ? '☑' : '☐'}</button><button onClick={() => openNote(task.path)}><b>{task.text}</b><span>{task.path} · line {task.line}</span></button></div>) : <p className="empty-home">No {state} tasks found.</p>}</section></div>;
}

function QuickCapturePanel({ close, capture }: { close: () => void; capture: (text: string, tag: string) => Promise<void> }) {
  const [text, setText] = React.useState(''); const [tag, setTag] = React.useState(''); const [error, setError] = React.useState('');
  return <div className="modal-backdrop" onMouseDown={close}><form className="panel-modal capture-panel" onMouseDown={e => e.stopPropagation()} onSubmit={async e => { e.preventDefault(); try { await capture(text, tag); } catch (err) { setError(err instanceof Error ? err.message : 'Capture failed'); } }}><div className="panel-head"><div><h2>Quick capture</h2><p>Save a thought as portable Markdown in Inbox.</p></div><button type="button" onClick={close}>×</button></div><textarea autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="What do you want to remember?" /><label><span>Optional tag</span><input value={tag} onChange={e => setTag(e.target.value)} placeholder="projects" /></label>{error && <p className="form-error">{error}</p>}<div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary-action" type="submit">Capture to Inbox</button></div></form></div>;
}

function TemplatePicker({ templates, close, create }: { templates: TemplateItem[]; close: () => void; create: (templatePath: string, destination: string, title: string) => Promise<void> }) {
  const [selected, setSelected] = React.useState(templates[0]?.path || ''); const [destination, setDestination] = React.useState(''); const [title, setTitle] = React.useState(''); const [error, setError] = React.useState('');
  return <div className="modal-backdrop" onMouseDown={close}><form className="panel-modal template-panel" onMouseDown={e => e.stopPropagation()} onSubmit={async e => { e.preventDefault(); try { await create(selected, destination, title); } catch (err) { setError(err instanceof Error ? err.message : 'Could not create note'); } }}><div className="panel-head"><div><h2>New from template</h2><p>Templates are ordinary Markdown files in Templates.</p></div><button type="button" onClick={close}>×</button></div>{templates.length ? <><label><span>Template</span><select value={selected} onChange={e => setSelected(e.target.value)}>{templates.map(template => <option key={template.path} value={template.path}>{template.title}</option>)}</select></label><label><span>New note path</span><input value={destination} onChange={e => setDestination(e.target.value)} placeholder="Projects/New note" required /></label><label><span>Title</span><input value={title} onChange={e => setTitle(e.target.value)} placeholder="Optional; defaults to filename" /></label>{error && <p className="form-error">{error}</p>}<div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary-action" type="submit">Create note</button></div></> : <><p className="empty-home">Create Markdown files inside the Templates folder to use them here.</p><div className="dialog-actions"><button type="button" onClick={close}>Close</button></div></>}</form></div>;
}

function WebClipperPanel({ templates, close, clip, saveTemplate }: { templates: WebClipTemplate[]; close: () => void; clip: (url: string, templateId: string, title: string) => Promise<void>; saveTemplate: (template: Omit<WebClipTemplate, 'body'> & { body: string }) => Promise<void> }) {
  const [url, setUrl] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [templateId, setTemplateId] = React.useState('article');
  const [editingTemplate, setEditingTemplate] = React.useState(false);
  const [error, setError] = React.useState('');
  const [draft, setDraft] = React.useState({ id: '', name: '', folder: 'Web Research', description: '', body: `---\ntitle: {{title}}\nsource: {{url}}\ncaptured_at: {{captured_at}}\n---\n\n# {{title}}\n\n{{description}}\n\n## Saved content\n\n{{content}}\n\n## Sources\n\n{{citations}}\n` });
  const selected = templates.find(template => template.id === templateId) || templates[0];
  const updateDraft = (key: keyof typeof draft, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const submitClip = async (event: React.FormEvent) => {
    event.preventDefault();
    try { await clip(url.trim(), templateId, title.trim()); } catch (err) { setError(err instanceof Error ? err.message : 'Could not clip this page'); }
  };
  const submitTemplate = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await saveTemplate(draft);
      setTemplateId(draft.id.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'));
      setEditingTemplate(false);
      setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save template'); }
  };
  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="panel-modal web-clipper-panel" role="dialog" aria-modal="true" aria-label="Web clipper" onMouseDown={event => event.stopPropagation()}>
      <div className="panel-head"><div><h2>{editingTemplate ? 'Create web clip template' : 'Web clipper'}</h2><p>{editingTemplate ? 'Use portable Markdown tokens to adapt Safire to a favorite site.' : 'Capture a public page into durable, offline-readable Markdown.'}</p></div><button type="button" onClick={close}>×</button></div>
      {editingTemplate ? <form onSubmit={submitTemplate} className="web-clip-form">
        <div className="web-clip-grid"><label><span>Template name</span><input autoFocus value={draft.name} onChange={event => updateDraft('name', event.target.value)} placeholder="My site article" required /></label><label><span>Template id</span><input value={draft.id} onChange={event => updateDraft('id', event.target.value)} placeholder="my-site-article" required /></label></div>
        <label><span>Destination folder</span><input value={draft.folder} onChange={event => updateDraft('folder', event.target.value)} placeholder="Web Research" required /></label>
        <label><span>What it is for</span><input value={draft.description} onChange={event => updateDraft('description', event.target.value)} placeholder="Saved articles from a favorite site" /></label>
        <label><span>Markdown layout</span><textarea value={draft.body} onChange={event => updateDraft('body', event.target.value)} required /></label>
        <p className="template-token-help"><b>Tokens:</b> {'{{title}}'} {'{{url}}'} {'{{author}}'} {'{{description}}'} {'{{captured_at}}'} {'{{content}}'} {'{{citations}}'} {'{{footnotes}}'}</p>
        {error && <p className="form-error">{error}</p>}<div className="dialog-actions"><button type="button" onClick={() => { setEditingTemplate(false); setError(''); }}>Back to clipper</button><button className="primary-action" type="submit">Save custom template</button></div>
      </form> : <form onSubmit={submitClip} className="web-clip-form">
        <label><span>Page URL</span><input autoFocus inputMode="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/article" required /></label>
        <label><span>Optional title override</span><input value={title} onChange={event => setTitle(event.target.value)} placeholder="Use the page title" /></label>
        <div className="clip-template-heading"><div><b>Save as</b><span>{selected?.description || 'Choose a structured Markdown layout.'}</span></div><button type="button" onClick={() => { setEditingTemplate(true); setError(''); }}>+ Custom template</button></div>
        <div className="clip-template-options">{templates.map(template => <label className={template.id === templateId ? 'selected' : ''} key={template.id}><input type="radio" name="web-clip-template" value={template.id} checked={template.id === templateId} onChange={() => setTemplateId(template.id)} /><b>{template.name}</b><span>{template.description}</span><small>Web Clips/{template.folder}</small></label>)}</div>
        <p className="clip-privacy-note">Safire reads the page directly, writes its Markdown and metadata to your local vault, and does not send clips to a third party.</p>
        {error && <p className="form-error">{error}</p>}<div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary-action" type="submit">Capture page</button></div>
      </form>}
    </div>
  </div>;
}

function relativeTime(timestamp: number) { const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000)); return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`; }

function withAttachmentParam(url: string, key: 'raw' | 'download') {
  const next = new URL(url, window.location.href);
  next.searchParams.set(key, '1');
  return `${next.pathname}${next.search}`;
}

function AttachmentViewer({ viewer, close }: { viewer: AttachmentViewerState; close: () => void }) {
  const [text, setText] = React.useState<string>('');
  const [error, setError] = React.useState<string>('');
  const rawUrl = React.useMemo(() => withAttachmentParam(viewer.url, 'raw'), [viewer.url]);
  const downloadUrl = React.useMemo(() => withAttachmentParam(viewer.url, 'download'), [viewer.url]);

  React.useEffect(() => {
    let cancelled = false;
    setText('');
    setError('');
    if (viewer.kind !== 'text') return () => { cancelled = true; };
    fetch(rawUrl)
      .then(async res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then(data => { if (!cancelled) setText(data); })
      .catch(err => { if (!cancelled) setError(err.message || 'Could not load text attachment'); });
    return () => { cancelled = true; };
  }, [rawUrl, viewer.kind]);

  return <div className="modal-backdrop attachment-backdrop" onMouseDown={close}>
    <div className="panel-modal attachment-viewer" role="dialog" aria-modal="true" aria-label={`Attachment preview: ${viewer.name}`} onMouseDown={e => e.stopPropagation()}>
      <button type="button" className="attachment-floating-back" onClick={close}>← Back to Safire</button>
      <div className="attachment-toolbar">
        <button type="button" className="primary-action back-to-note" onClick={close}>← Back to Safire</button>
        <div className="attachment-title"><h2>{viewer.name}</h2><p>Attachment preview. Use Back to Safire, Esc, or × to return to your note.</p></div>
        <button type="button" className="attachment-close" aria-label="Close attachment and return to Safire" onClick={close}>×</button>
      </div>
      <div className={`attachment-frame ${viewer.kind === 'text' ? 'text-frame' : ''}`}>
        {viewer.kind === 'image' && <img src={rawUrl} alt={viewer.name} />}
        {viewer.kind === 'text' && (error ? <div className="attachment-error">{error}</div> : <pre>{text || 'Loading text attachment…'}</pre>)}
        {viewer.kind === 'document' && <iframe title={viewer.name} src={rawUrl} sandbox="" />}
      </div>
      <div className="attachment-actions"><a className="secondary-action" href={downloadUrl} download={viewer.name}>Download file</a><button type="button" className="primary-action" onClick={close}>← Back to Safire</button></div>
    </div>
  </div>;
}

function ImageResizeMenu({ menu, apply, close }: { menu: ImageResizeMenuState; apply: (index: number, size: ImageSize | null) => void; close: () => void }) {
  return <div className="image-size-popover" style={{ left: menu.x, top: menu.y }} role="dialog" aria-label={`Resize image: ${menu.alt}`}>
    <div className="image-size-head"><div><b>Image size</b><span>{menu.alt}</span></div><button type="button" onClick={close} aria-label="Close image size menu">×</button></div>
    <div className="image-size-options">
      {IMAGE_SIZES.map(option => <button key={option.label} type="button" className={menu.size === option.value ? 'active' : ''} onClick={() => apply(menu.index, option.value)}>
        <b>{option.label}</b><span>{option.hint}</span>
      </button>)}
    </div>
    <p>Pick a size for this picture. “Use default” removes the custom size marker from the note.</p>
  </div>;
}

function EvidenceComposer({ close, insert }: { close: () => void; insert: (draft: EvidenceDraft) => void }) {
  const [draft, setDraft] = React.useState<EvidenceDraft>(defaultEvidenceDraft);
  const [details, setDetails] = React.useState(false);
  const update = <K extends keyof EvidenceDraft>(key: K, value: EvidenceDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  return <div className="modal-backdrop" onMouseDown={close}><form className="panel-modal evidence-composer" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); insert(draft); }}>
    <div className="panel-head"><div><h2>Evidence receipt</h2><p>Private by default: this inserts portable local Markdown only. Nothing is shared or synced.</p></div><button type="button" onClick={close}>×</button></div>
    <div className="evidence-form-grid"><label className="wide"><span>Claim or label</span><input autoFocus value={draft.claim} onChange={event => update('claim', event.target.value)} placeholder="What important claim are you recording?" required /></label><label><span>Source type</span><select value={draft.sourceType} onChange={event => update('sourceType', event.target.value as EvidenceSourceType)}>{EVIDENCE_SOURCES.map(source => <option key={source.value} value={source.value}>{source.label}</option>)}</select></label><label><span>Result status</span><select value={draft.status} onChange={event => update('status', event.target.value as EvidenceStatus)}>{EVIDENCE_STATUSES.map(status => <option key={status} value={status}>{status}</option>)}</select></label><label className="wide"><span>Source URL or local path</span><input value={draft.source} onChange={event => update('source', event.target.value)} placeholder="https://… or C:\\…" /></label><label><span>Observed at</span><input type="datetime-local" value={draft.observedAt.slice(0, 16)} onChange={event => update('observedAt', event.target.value ? new Date(event.target.value).toISOString() : '')} /></label><label><span>Freshness / expiry</span><input type="datetime-local" value={draft.freshness.slice(0, 16)} onChange={event => update('freshness', event.target.value ? new Date(event.target.value).toISOString() : '')} /></label></div>
    <button type="button" className="evidence-details-toggle" onClick={() => setDetails(value => !value)}>{details ? 'Hide detailed evidence' : 'Add action, verification, excerpt, hash, and private notes'}</button>
    {details && <div className="evidence-form-grid evidence-details"><label className="wide"><span>Action performed</span><input value={draft.action} onChange={event => update('action', event.target.value)} placeholder="What was done?" /></label><label className="wide"><span>Verification predicate / test</span><input value={draft.verification} onChange={event => update('verification', event.target.value)} placeholder="What condition proves or challenges the claim?" /></label><label className="wide"><span>Evidence excerpt</span><textarea value={draft.excerpt} onChange={event => update('excerpt', event.target.value)} /></label><label><span>SHA-256 / hash</span><input value={draft.hash} onChange={event => update('hash', event.target.value)} /></label><label><span>Private notes</span><input value={draft.privateNotes} onChange={event => update('privateNotes', event.target.value)} /></label></div>}
    <div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary-action" type="submit">Insert receipt</button></div>
  </form></div>;
}

function EvidencePanel({ receipts, close, add }: { receipts: EvidenceReceipt[]; close: () => void; add: () => void }) {
  const [selected, setSelected] = React.useState<string[]>(() => receipts.map(receipt => receipt.id));
  const [redactions, setRedactions] = React.useState<Set<keyof EvidenceDraft>>(() => new Set(['privateNotes']));
  const selectedReceipts = receipts.filter(receipt => selected.includes(receipt.id));
  const clean = (receipt: EvidenceReceipt) => {
    const copy: Record<string, unknown> = { ...receipt }; delete copy.expired;
    for (const field of redactions) delete copy[field];
    return copy;
  };
  const markdown = () => selectedReceipts.map(receipt => formatEvidenceReceipt({ ...receipt, ...Object.fromEntries([...redactions].map(field => [field, ''])) })).join('\n\n');
  const copyMarkdown = async () => { const text = markdown(); await navigator.clipboard.writeText(text); };
  const exportJson = () => { const blob = new Blob([JSON.stringify(selectedReceipts.map(clean), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'safire-evidence-receipts.json'; anchor.click(); URL.revokeObjectURL(url); };
  const toggleReceipt = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const toggleRedaction = (field: keyof EvidenceDraft) => setRedactions(current => { const next = new Set(current); next.has(field) ? next.delete(field) : next.add(field); return next; });
  return <div className="modal-backdrop" onMouseDown={close}><section className="panel-modal evidence-panel" onMouseDown={event => event.stopPropagation()}><div className="panel-head"><div><h2>Evidence for this note</h2><p>Select receipt(s), redact fields, then copy portable Markdown or export local JSON.</p></div><button onClick={close}>×</button></div>{receipts.length ? <><div className="evidence-export-actions"><button onClick={() => setSelected(receipts.map(receipt => receipt.id))}>Select all</button><button onClick={() => setSelected([])}>Clear</button><button className="primary-action" disabled={!selectedReceipts.length} onClick={() => void copyMarkdown()}>Copy Markdown</button><button disabled={!selectedReceipts.length} onClick={exportJson}>Export JSON</button></div><div className="evidence-receipt-list">{receipts.map(receipt => <label key={receipt.id}><input type="checkbox" checked={selected.includes(receipt.id)} onChange={() => toggleReceipt(receipt.id)} /><span className={`evidence-status ${receipt.status}`}>{receipt.status}</span><b>{receipt.claim || 'Untitled receipt'}</b><small>{EVIDENCE_SOURCES.find(source => source.value === receipt.sourceType)?.label} · {receipt.observedAt ? new Date(receipt.observedAt).toLocaleString() : 'No timestamp'}{receipt.expired ? ' · expired' : ''}</small></label>)}</div><fieldset className="evidence-redactions"><legend>Redact before copy/export</legend>{EVIDENCE_FIELDS.map(field => <label key={field.key}><input type="checkbox" checked={redactions.has(field.key)} onChange={() => toggleRedaction(field.key)} /> {field.label}</label>)}</fieldset></> : <p className="empty-home">No receipts in this note yet.</p>}<div className="dialog-actions"><button onClick={close}>Close</button><button className="primary-action" onClick={add}>Add receipt</button></div></section></div>;
}

function MarkdownToolbar({ insert, attach, evidence }: { insert: (before: string, after?: string, placeholder?: string) => void; attach: () => void; evidence: () => void }) {
  const buttons = [
    ['H1', '# ', '', 'Heading'],
    ['H2', '## ', '', 'Heading'],
    ['B', '**', '**', 'bold text'],
    ['I', '*', '*', 'italic text'],
    ['`Code`', '`', '`', 'code'],
    ['Quote', '> ', '', 'quote'],
    ['List', '- ', '', 'list item'],
    ['Task', '- [ ] ', '', 'task'],
    ['Link', '[', '](https://)', 'link text'],
    ['Wiki', '[[', ']]', 'Note Name'],
  ] as const;
  return <div className="markdown-toolbar">
    {buttons.map(([label, before, after, placeholder]) => <button key={label} type="button" onClick={() => insert(before, after, placeholder)}>{label}</button>)}
    <button type="button" onClick={() => insert('```\n', '\n```', 'code')}>Block</button>
    <button type="button" onClick={evidence}>Evidence</button>
    <button type="button" onClick={attach}>Attach file</button>
  </div>;
}

function SettingsPanel({ settings, close, save }: { settings: SafireSettings; close: () => void; save: (settings: SafireSettings) => Promise<void> }) {
  const [draft, setDraft] = React.useState(settings);
  const update = <K extends keyof SafireSettings>(key: K, value: SafireSettings[K]) => setDraft(prev => ({ ...prev, [key]: value }));
  return <div className="modal-backdrop" onMouseDown={close}>
    <form className="panel-modal settings-panel" onMouseDown={e => e.stopPropagation()} onSubmit={async e => { e.preventDefault(); await save(draft); close(); }}>
      <div className="panel-head"><div><h2>Safire Settings</h2><p>Vault-backed application preferences.</p></div><button type="button" onClick={close}>×</button></div>
      <label><span>Autosave</span><input type="checkbox" checked={draft.autosave} onChange={e => update('autosave', e.target.checked)} /></label>
      <label><span>Autosave delay, ms</span><input type="number" min={250} max={10000} step={50} value={draft.autosaveDelay} onChange={e => update('autosaveDelay', Number(e.target.value))} /></label>
      <label><span>Startup note</span><input value={draft.startupNote} onChange={e => update('startupNote', e.target.value)} /></label>
      <label><span>Default view</span><select value={draft.defaultMode} onChange={e => update('defaultMode', e.target.value as Mode)}><option value="split">Split</option><option value="edit">Edit</option><option value="preview">Preview</option><option value="graph">Graph</option></select></label>
      <label><span>Daily notes folder</span><input value={draft.dailyNotesFolder} onChange={e => update('dailyNotesFolder', e.target.value)} /></label>
      <label><span>Backup retention days</span><input type="number" min={1} max={365} value={draft.backupRetentionDays} onChange={e => update('backupRetentionDays', Number(e.target.value))} /></label>
      <label><span>Confirm deletes</span><input type="checkbox" checked={draft.confirmDeletes} onChange={e => update('confirmDeletes', e.target.checked)} /></label>
      <label><span>Fit images to page</span><input type="checkbox" checked={draft.fitImagesToPage !== false} onChange={e => update('fitImagesToPage', e.target.checked)} /></label>
      <label><span>Theme</span><select value={draft.theme} onChange={e => update('theme', e.target.value as ThemeMode)}><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <div className="dialog-actions"><button type="button" className="primary-action cancel-action" onClick={close}>Cancel</button><button type="submit" className="primary-action">Save settings</button></div>
    </form>
  </div>;
}

function BackupsPanel({ activePath, backups, preview, close, refresh, show, restore }: { activePath: string; backups: BackupItem[]; preview: { item: BackupItem; content: string } | null; close: () => void; refresh: () => Promise<BackupItem[]>; show: (item: BackupItem) => Promise<void>; restore: (item: BackupItem) => Promise<void> }) {
  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="panel-modal backups-panel" onMouseDown={e => e.stopPropagation()}>
      <div className="panel-head"><div><h2>Backups for {activePath}</h2><p>Preview or restore the versions Safire created before saves/deletes.</p></div><button onClick={close}>×</button></div>
      <div className="backup-layout">
        <div className="backup-list">
          <button className="primary-action wide" onClick={() => refresh()}>Refresh backups</button>
          {backups.length ? backups.map(b => <button key={b.id} className={preview?.item.id === b.id ? 'backup-row active' : 'backup-row'} onClick={() => show(b)}>
            <b>{new Date(b.createdAt).toLocaleString()}</b><span>{Math.round(b.size / 1024 * 10) / 10} KB</span>
          </button>) : <p className="empty">No backups yet. Edit and save this note to create one.</p>}
        </div>
        <div className="backup-preview">
          {preview ? <><div className="preview-head"><b>{new Date(preview.item.createdAt).toLocaleString()}</b><button className="danger-action" onClick={() => restore(preview.item)}>Restore this backup</button></div><pre>{preview.content}</pre></> : <p className="empty">Select a backup to preview it.</p>}
        </div>
      </div>
    </div>
  </div>;
}

function SafireModal({ dialog, close, done }: { dialog: SafireDialog; close: () => void; done: (value: string | boolean | null) => void }) {
  const [value, setValue] = React.useState(dialog.kind === 'input' ? dialog.defaultValue || '' : '');
  React.useEffect(() => {
    const el = document.querySelector('.safire-dialog input') as HTMLInputElement | null;
    setTimeout(() => { el?.focus(); el?.select(); }, 20);
  }, []);
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (dialog.kind === 'input') done(value.trim() || null);
    else done(true);
  };
  return <div className="modal-backdrop" onMouseDown={close}>
    <form className="palette safire-dialog" onMouseDown={e => e.stopPropagation()} onSubmit={submit}>
      <h2>{dialog.title}</h2>
      <p>{dialog.message}</p>
      {dialog.kind === 'input' && <input value={value} onChange={e => setValue(e.target.value)} placeholder={dialog.placeholder || ''} />}
      <div className="dialog-actions">
        <button type="button" onClick={close}>Cancel</button>
        <button type="submit" className={dialog.danger ? 'danger-action' : 'primary-action'}>{dialog.confirmLabel || 'OK'}</button>
      </div>
    </form>
  </div>;
}

function FileTree({ nodes, activePath, openNote, depth = 0 }: { nodes: TreeNode[]; activePath: string; openNote: (path: string) => void; depth?: number }) {
  const [closed, setClosed] = React.useState<Record<string, boolean>>({});
  return <div className="file-tree">{nodes.map(n => n.type === 'folder' ? <div key={n.path}><button className="folder-row" style={{ paddingLeft: 8 + depth*14 }} onClick={() => setClosed(c => ({ ...c, [n.path]: !c[n.path] }))}>{closed[n.path] ? '▸' : '▾'} {n.name}</button>{!closed[n.path] && <FileTree nodes={n.children || []} activePath={activePath} openNote={openNote} depth={depth+1} />}</div> : <button key={n.path} className={'file-row '+(n.path===activePath?'active':'')} style={{ paddingLeft: 8 + depth*14 }} onClick={() => openNote(n.path)}>◦ {n.title}</button>)}</div>;
}

function Palette({ title, query, setQuery, close, items }: { title: string; query: string; setQuery: (q: string) => void; close: () => void; items: { label: string; sub: string; run: () => void|Promise<void> }[] }) {
  const filtered = items.filter(i => (i.label + ' ' + i.sub).toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  const [selected, setSelected] = React.useState(0);
  React.useEffect(() => { setSelected(0); }, [query, title]);
  React.useEffect(() => { const el = document.querySelector('.palette input') as HTMLInputElement | null; setTimeout(() => el?.focus(), 20); }, []);
  const runSelected = async () => { const item = filtered[Math.min(selected, Math.max(0, filtered.length - 1))]; if (item) await item.run(); };
  return <div className="modal-backdrop" onMouseDown={close}><div className="palette" onMouseDown={e => e.stopPropagation()}><h2>{title}</h2><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Type to filter..." onKeyDown={e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(filtered.length - 1, i + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(0, i - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); runSelected(); }
    if (e.key === 'Escape') close();
  }} /> <div>{filtered.map((item, i) => <button key={item.label} className={i === selected ? 'selected' : ''} onMouseEnter={() => setSelected(i)} onClick={() => item.run()}><b>{item.label}</b><span>{item.sub}</span>{i===selected && <kbd>Enter</kbd>}</button>)}</div></div></div>;
}

function GraphNotePanel({ mode, path, content, dirty, close, setMode, save, setContent }: { mode: GraphPanel['mode']; path: string; content: string; dirty: boolean; close: () => void; setMode: (mode: GraphPanel['mode']) => void; save: () => void; setContent: (value: string) => void }) {
  const panelRef = React.useRef<HTMLElement | null>(null);
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null);
  const previewRef = React.useRef<HTMLElement | null>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const closeRef = React.useRef(close);
  closeRef.current = close;
  const rendered = React.useMemo(() => ({ __html: renderMarkdown(content) }), [content]);
  React.useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])') || [])].filter(element => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);
  React.useEffect(() => {
    const focusPanel = window.setTimeout(() => (mode === 'edit' ? editorRef.current : previewRef.current)?.focus(), 0);
    return () => window.clearTimeout(focusPanel);
  }, [mode, path]);
  return <div className="graph-note-backdrop" onMouseDown={close}>
    <section ref={panelRef} className="graph-note-panel" role="dialog" aria-modal="true" aria-label={`${mode === 'edit' ? 'Edit' : 'Preview'} ${path}`} onMouseDown={event => event.stopPropagation()}>
      <header><div><span>Graph note · Connected workspace</span><h2>{titleFromPath(path)}</h2><p>{path}{dirty ? ' · unsaved changes' : ''} · Scroll to read the complete note.</p></div><div className="graph-note-actions"><button onClick={() => setMode('preview')} className={mode === 'preview' ? 'on' : ''}>Preview</button><button onClick={() => setMode('edit')} className={mode === 'edit' ? 'on' : ''}>Edit</button><button className="back-to-graph" onClick={close}>Back to graph</button></div></header>
      {mode === 'edit' ? <textarea ref={editorRef} className="graph-note-editor" value={content} spellCheck="true" onChange={event => setContent(event.target.value)} /> : <article ref={previewRef} className="graph-note-preview markdown" tabIndex={0} aria-label={`Scrollable preview of ${titleFromPath(path)}`} dangerouslySetInnerHTML={rendered} />}
      <footer>{mode === 'edit' && <button className="primary" onClick={save} disabled={!dirty}>Save note</button>}<button onClick={close}>Close</button></footer>
    </section>
  </div>;
}


createRoot(document.getElementById('root')!).render(<App />);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
