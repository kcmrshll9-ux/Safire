export const GRAPH_RENDER_LIMITS = Object.freeze({
  notes: 1_000,
  missing: 250,
  links: 2_000,
});

export function graphSourceLinkCountLabel(count: number, complete = true) {
  return complete ? `${count}` : `at least ${count}`;
}

type GraphBudgetNode = { id: string };
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
  const addNode = (node: Node | undefined) => {
    if (!node || nodeIds.has(node.id) || nodes.length >= GRAPH_RENDER_LIMITS.notes) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  if (activePath) addNode(graph.nodes.find(node => node.id === activePath));
  for (const node of graph.nodes) {
    addNode(node);
    if (nodes.length >= GRAPH_RENDER_LIMITS.notes) break;
  }

  const unresolvedTargets = new Set<string>();
  const links: Link[] = [];
  for (const link of graph.links) {
    if (links.length >= GRAPH_RENDER_LIMITS.links) break;
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
  }

  return {
    graph: { nodes, links },
    renderedNotes: nodes.length,
    renderedLinks: links.length,
    renderedMissing: unresolvedTargets.size,
    sourceNotes: graph.nodes.length,
    sourceLinks: graph.links.length,
    truncated: nodes.length < graph.nodes.length || links.length < graph.links.length,
  };
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character] || character));
}

/**
 * A recognized YouTube link gets local-only decoration. No image, iframe, or
 * other subresource is emitted; the browser contacts YouTube only after a click.
 */
export function renderYouTubeLinkCard(href: string, labelHtml: string, title?: string | null) {
  const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
  return `<a class="youtube-link-card" href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>
    <span class="youtube-thumb-wrap youtube-local-placeholder" aria-hidden="true"><span class="youtube-play">▶</span></span>
    <span class="youtube-link-copy"><span class="youtube-eyebrow">YouTube link</span><span class="youtube-title">${labelHtml}</span></span>
  </a>`;
}
