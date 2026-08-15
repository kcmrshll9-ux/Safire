export const GRAPH_RENDER_LIMITS = Object.freeze({
  notes: 1_000,
  missing: 250,
  links: 2_000,
  sourceItems: 8_000,
  tagsPerNode: 32,
  fieldCharacters: 1_024,
  aggregateStringCharacters: 512 * 1_024,
});

export function graphSourceLinkCountLabel(count: number, complete = true) {
  return complete ? `${count}` : `at least ${count}`;
}

export function getYouTubeVideoId(href: string, baseHref = 'https://safire.invalid/') {
  try {
    const url = new URL(href, baseHref);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
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

type GraphBudgetNode = {
  id: string;
  label?: string;
  folder?: string;
  tags?: string[];
};
type GraphBudgetLink = {
  source: string;
  target: string;
  resolved: boolean;
  resolution: string;
};

type GraphBudgetInput<Node extends GraphBudgetNode, Link extends GraphBudgetLink> = {
  nodes: Node[];
  links: Link[];
};

function unresolvedTargetKey(link: GraphBudgetLink) {
  return `${link.resolution}\u0000${link.target.toLocaleLowerCase()}`;
}

function boundedString(value: unknown) {
  return typeof value === 'string' && value.length <= GRAPH_RENDER_LIMITS.fieldCharacters;
}

function nodeStringCharacters(node: GraphBudgetNode) {
  if (!boundedString(node.id) || !boundedString(node.label ?? '') || !boundedString(node.folder ?? '')) return -1;
  if (node.tags !== undefined) {
    if (!Array.isArray(node.tags) || node.tags.length > GRAPH_RENDER_LIMITS.tagsPerNode || node.tags.some(tag => !boundedString(tag))) return -1;
  }
  return node.id.length + (node.label?.length || 0) + (node.folder?.length || 0) + (node.tags || []).reduce((total, tag) => total + tag.length, 0);
}

function linkStringCharacters(link: GraphBudgetLink) {
  const values = [link.source, link.target, link.resolution, (link as GraphBudgetLink & { id?: unknown }).id, (link as GraphBudgetLink & { label?: unknown }).label]
    .filter(value => value !== undefined);
  if (values.some(value => !boundedString(value))) return -1;
  return values.reduce<number>((total, value) => total + String(value).length, 0);
}

/**
 * Applies a deterministic, defensive render budget before the graph view creates
 * unresolved placeholders, force-layout state, or SVG elements. The active note
 * is retained when it exists, followed by the server's stable node/link order.
 */
export function limitGraphForRendering<Node extends GraphBudgetNode, Link extends GraphBudgetLink>(
  graph: GraphBudgetInput<Node, Link>,
  activePath = '',
) {
  const nodes: Node[] = [];
  const nodeIds = new Set<string>();
  let renderedStringCharacters = 0;
  let rejectedItem = false;
  const addNode = (node: Node | undefined) => {
    if (!node || nodeIds.has(node.id) || nodes.length >= GRAPH_RENDER_LIMITS.notes) return;
    const stringCharacters = nodeStringCharacters(node);
    if (stringCharacters < 0 || renderedStringCharacters + stringCharacters > GRAPH_RENDER_LIMITS.aggregateStringCharacters) {
      rejectedItem = true;
      return;
    }
    nodeIds.add(node.id);
    nodes.push(node);
    renderedStringCharacters += stringCharacters;
  };

  const sourceNodes = graph.nodes.slice(0, GRAPH_RENDER_LIMITS.sourceItems);
  if (activePath) addNode(sourceNodes.find(node => node.id === activePath));
  for (const node of sourceNodes) {
    addNode(node);
    if (nodes.length >= GRAPH_RENDER_LIMITS.notes) break;
  }

  const unresolvedTargets = new Set<string>();
  const links: Link[] = [];
  for (const link of graph.links.slice(0, GRAPH_RENDER_LIMITS.sourceItems)) {
    if (links.length >= GRAPH_RENDER_LIMITS.links) break;
    const stringCharacters = linkStringCharacters(link);
    if (stringCharacters < 0 || renderedStringCharacters + stringCharacters > GRAPH_RENDER_LIMITS.aggregateStringCharacters) {
      rejectedItem = true;
      continue;
    }
    if (!nodeIds.has(link.source)) continue;
    if (link.resolved) {
      if (!nodeIds.has(link.target)) continue;
    } else {
      const key = unresolvedTargetKey(link);
      if (!unresolvedTargets.has(key)) {
        if (unresolvedTargets.size >= GRAPH_RENDER_LIMITS.missing) continue;
        unresolvedTargets.add(key);
      }
    }
    links.push(link);
    renderedStringCharacters += stringCharacters;
  }

  return {
    graph: { nodes, links },
    renderedNotes: nodes.length,
    renderedLinks: links.length,
    renderedMissing: unresolvedTargets.size,
    renderedStringCharacters,
    sourceNotes: graph.nodes.length,
    sourceLinks: graph.links.length,
    truncated: rejectedItem || nodes.length < graph.nodes.length || links.length < graph.links.length,
  };
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character] || character));
}

const MARKDOWN_PREVIEW_CLASSES = new Set([
  'conflicting',
  'evidence-badge',
  'evidence-claim',
  'evidence-source',
  'evidence-status',
  'expired',
  'inferred',
  'safire-evidence-callout',
  'safire-preview-image',
  'stale',
  'unavailable',
  'verified',
  'youtube-eyebrow',
  'youtube-link-card',
  'youtube-link-copy',
  'youtube-local-placeholder',
  'youtube-play',
  'youtube-thumb-wrap',
  'youtube-title',
]);

/** Prevents imported Markdown from borrowing privileged application classes. */
export function filterMarkdownClassName(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.split(/\s+/).filter(className => MARKDOWN_PREVIEW_CLASSES.has(className)).join(' ');
}

type InlineLabelToken = {
  type?: unknown;
  text?: unknown;
  raw?: unknown;
  tokens?: unknown;
};

const YOUTUBE_LABEL_TEXT_LIMIT = 512;
const YOUTUBE_LABEL_TOKEN_LIMIT = 128;

function safeYouTubeLabel(tokens: unknown) {
  const state = { remaining: YOUTUBE_LABEL_TEXT_LIMIT, visited: 0 };
  const render = (values: unknown, depth: number): string => {
    if (!Array.isArray(values) || depth > 8 || state.remaining <= 0) return '';
    let output = '';
    for (const candidate of values) {
      if (state.remaining <= 0 || state.visited >= YOUTUBE_LABEL_TOKEN_LIMIT) break;
      state.visited += 1;
      if (!candidate || typeof candidate !== 'object') continue;
      const token = candidate as InlineLabelToken;
      const type = typeof token.type === 'string' ? token.type : '';
      const nested = () => render(token.tokens, depth + 1);
      const text = () => {
        const value = typeof token.text === 'string' ? token.text : '';
        const retained = value.slice(0, state.remaining);
        state.remaining -= retained.length;
        return escapeHtmlAttribute(retained);
      };
      if (type === 'strong' || type === 'em' || type === 'del') {
        const body = nested();
        if (body) output += `<${type}>${body}</${type}>`;
      } else if (type === 'codespan') {
        const body = text();
        if (body) output += `<code>${body}</code>`;
      } else if (type === 'br') {
        output += '<br>';
      } else if (type === 'image') {
        output += Array.isArray(token.tokens) ? nested() : text();
      } else if (type === 'link') {
        output += nested();
      } else if (type === 'text' || type === 'escape') {
        output += Array.isArray(token.tokens) ? nested() : text();
      } else if (type !== 'html') {
        output += Array.isArray(token.tokens) ? nested() : text();
      }
    }
    return output;
  };
  return render(tokens, 0) || 'YouTube video';
}

/**
 * A recognized YouTube link gets local-only decoration. No image, iframe, or
 * other subresource is emitted; the browser contacts YouTube only after a click.
 */
export function renderYouTubeLinkCard(href: string, labelTokens: unknown, title?: string | null) {
  const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
  return `<a class="youtube-link-card" href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>
    <span class="youtube-thumb-wrap youtube-local-placeholder" aria-hidden="true"><span class="youtube-play">▶</span></span>
    <span class="youtube-link-copy"><span class="youtube-eyebrow">YouTube link</span><span class="youtube-title">${safeYouTubeLabel(labelTokens)}</span></span>
  </a>`;
}
