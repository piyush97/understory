import type { Diagram, DiagramNode } from "./explanation";

const NODE_W = 156;
const NODE_H = 84;
const GAP_X = 64;
const GAP_Y = 28;
const PAD_X = 32;
const PAD_Y = 44;

export function renderDiagramSvg(diagram: Diagram): string {
  const suffix = shortHash(`${diagram.title}:${diagram.description}`);
  const titleId = `dg-title-${suffix}`;
  const descId = `dg-desc-${suffix}`;
  const markerId = `dg-arrow-${suffix}`;
  const label = escapeXml(diagram.title);
  const description = escapeXml(diagram.description);

  if (diagram.kind === "sequence") {
    return renderSequence(diagram, { titleId, descId, markerId, label, description });
  }

  const ranks = assignRanks(diagram);
  const byRank = new Map<number, DiagramNode[]>();
  for (const node of diagram.nodes) {
    const rank = ranks.get(node.id) ?? 0;
    const bucket = byRank.get(rank) ?? [];
    bucket.push(node);
    byRank.set(rank, bucket);
  }

  const rankCount = Math.max(...byRank.keys(), 0) + 1;
  const maxRows = Math.max(...[...byRank.values()].map((nodes) => nodes.length), 1);
  const width = PAD_X * 2 + rankCount * NODE_W + (rankCount - 1) * GAP_X;
  const height = PAD_Y * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y + 12;
  const columnHeight = maxRows * NODE_H + (maxRows - 1) * GAP_Y;

  const positions = new Map<string, { x: number; y: number; rank: number }>();
  for (const [rank, nodes] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    const thisHeight = nodes.length * NODE_H + (nodes.length - 1) * GAP_Y;
    const offset = (columnHeight - thisHeight) / 2;
    nodes.forEach((node, index) => {
      positions.set(node.id, {
        x: PAD_X + rank * (NODE_W + GAP_X),
        y: PAD_Y + 6 + offset + index * (NODE_H + GAP_Y),
        rank,
      });
    });
  }

  const laneByGap = new Map<number, number>();
  const edges = diagram.edges
    .map((edge, index) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return "";
      return renderEdge(edge, from, to, laneByGap, markerId, index);
    })
    .join("");

  const nodes = diagram.nodes
    .map((node) => {
      const pos = positions.get(node.id);
      if (!pos) return "";
      return renderNode(node, pos, suffix);
    })
    .join("");

  return `<svg class="diagram-svg" viewBox="0 0 ${round(width)} ${round(height)}" role="img" aria-labelledby="${titleId} ${descId}" xmlns="http://www.w3.org/2000/svg">
  <title id="${titleId}">${label}</title>
  <desc id="${descId}">${description}</desc>
  <defs>
    <marker id="${markerId}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 8 4 L 0 8 z" class="dg-arrowhead"></path>
    </marker>
  </defs>
  <g class="dg-edges">${edges}</g>
  <g class="dg-nodes">${nodes}</g>
</svg>`;
}

function renderNode(
  node: DiagramNode,
  pos: { x: number; y: number; rank: number },
  suffix: string,
): string {
  const labelLines = wrapText(node.label, 18).slice(0, 2);
  const detailLines = node.detail ? wrapText(node.detail, 22).slice(0, 2) : [];
  const label = labelLines
    .map(
      (line, index) =>
        `<tspan x="${pos.x + 12}" dy="${index === 0 ? 0 : 15}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const detail = detailLines
    .map(
      (line, index) =>
        `<tspan x="${pos.x + 12}" dy="${index === 0 ? 0 : 13}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const cite = node.cite
    ? `<a href="#sources" class="dg-cite-link" aria-label="Source ${escapeXml(node.cite)}"><text class="dg-cite" x="${pos.x + NODE_W - 9}" y="${pos.y + 15}" text-anchor="end">${escapeXml(node.cite)}</text></a>`
    : "";
  const detailY = pos.y + 48;

  return `<g class="dg-node" data-node="${escapeXml(node.id)}" data-rank="${pos.rank}">
  <rect x="${pos.x}" y="${pos.y}" width="${NODE_W}" height="${NODE_H}" class="dg-node-box"></rect>
  <path d="M ${pos.x} ${pos.y + NODE_H - 18} H ${pos.x + NODE_W}" class="dg-node-rule"></path>
  <text class="dg-node-label" x="${pos.x + 12}" y="${pos.y + 27}">${label}</text>
  ${detail ? `<text class="dg-node-detail" x="${pos.x + 12}" y="${detailY}">${detail}</text>` : ""}
  ${cite}
  <text class="dg-node-id" x="${pos.x + 12}" y="${pos.y + NODE_H - 5}">${escapeXml(node.id.toUpperCase())}</text>
</g>`;
}

function renderEdge(
  edge: { from: string; to: string; label?: string; cite?: string },
  from: { x: number; y: number; rank: number },
  to: { x: number; y: number; rank: number },
  laneByGap: Map<number, number>,
  markerId: string,
  index: number,
): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  let path: string;
  let labelX: number;
  let labelY: number;

  if (from.rank === to.rank) {
    const bottom = Math.max(from.y, to.y) + NODE_H + 14;
    const midX = (from.x + to.x) / 2 + NODE_W / 2;
    path = `M ${from.x + NODE_W / 2} ${from.y + NODE_H} V ${bottom} H ${to.x + NODE_W / 2} V ${to.y + NODE_H}`;
    labelX = midX;
    labelY = bottom - 5;
  } else {
    const gap = Math.min(from.rank, to.rank);
    const lane = (laneByGap.get(gap) ?? 0) % 5;
    laneByGap.set(gap, lane + 1);
    const trackX =
      from.rank < to.rank
        ? from.x + NODE_W + GAP_X / 2 + (lane - 2) * 4
        : to.x - GAP_X / 2 + (lane - 2) * 4;
    path = `M ${x1} ${y1} H ${trackX} V ${y2} H ${x2}`;
    labelX = trackX;
    labelY = (y1 + y2) / 2 - 6;
  }

  const edgeLabel = edge.label
    ? `<text class="dg-edge-label" x="${labelX}" y="${labelY}" text-anchor="middle">${escapeXml(edge.label)}</text>`
    : "";
  const cite = edge.cite
    ? `<a href="#sources" class="dg-cite-link" aria-label="Source ${escapeXml(edge.cite)}"><text class="dg-edge-cite" x="${labelX}" y="${labelY + 13}" text-anchor="middle">${escapeXml(edge.cite)}</text></a>`
    : "";

  return `<g class="dg-edge" data-edge="${index}">
  <path d="${path}" class="dg-edge-line" marker-end="url(#${markerId})"></path>
  ${edgeLabel}
  ${cite}
</g>`;
}

function renderSequence(
  diagram: Diagram,
  ids: { titleId: string; descId: string; markerId: string; label: string; description: string },
): string {
  const width = Math.max(760, PAD_X * 2 + diagram.nodes.length * 170);
  const step = 46;
  const height = 92 + diagram.edges.length * step + 36;
  const actors = new Map<string, { x: number; y: number }>();
  const actorWidth = 120;

  diagram.nodes.forEach((node, index) => {
    const slot = width / diagram.nodes.length;
    actors.set(node.id, {
      x: PAD_X + index * slot + slot / 2,
      y: 34,
    });
  });

  const actorSvg = diagram.nodes
    .map((node) => {
      const actor = actors.get(node.id);
      if (!actor) return "";
      return `<g class="dg-actor">
  <rect x="${actor.x - actorWidth / 2}" y="${actor.y}" width="${actorWidth}" height="36" class="dg-node-box"></rect>
  <text class="dg-actor-label" x="${actor.x}" y="${actor.y + 23}" text-anchor="middle">${escapeXml(truncate(node.label, 18))}</text>
  <line x1="${actor.x}" y1="${actor.y + 36}" x2="${actor.x}" y2="${height - 18}" class="dg-life-line"></line>
</g>`;
    })
    .join("");

  const messages = diagram.edges
    .map((edge, index) => {
      const from = actors.get(edge.from);
      const to = actors.get(edge.to);
      if (!from || !to) return "";
      const y = 104 + index * step;
      const direction = to.x >= from.x ? 1 : -1;
      const x1 = from.x + direction * 4;
      const x2 = to.x - direction * 4;
      const labelX = (x1 + x2) / 2;
      return `<g class="dg-message">
  <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" class="dg-edge-line" marker-end="url(#${ids.markerId})"></line>
  <text class="dg-message-label" x="${labelX}" y="${y - 7}" text-anchor="middle">${escapeXml(edge.label ?? "")}</text>
  ${edge.cite ? `<a href="#sources" class="dg-cite-link" aria-label="Source ${escapeXml(edge.cite)}"><text class="dg-edge-cite" x="${labelX}" y="${y + 14}" text-anchor="middle">${escapeXml(edge.cite)}</text></a>` : ""}
</g>`;
    })
    .join("");

  return `<svg class="diagram-svg" viewBox="0 0 ${round(width)} ${round(height)}" role="img" aria-labelledby="${ids.titleId} ${ids.descId}" xmlns="http://www.w3.org/2000/svg">
  <title id="${ids.titleId}">${ids.label}</title>
  <desc id="${ids.descId}">${ids.description}</desc>
  <defs>
    <marker id="${ids.markerId}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 8 4 L 0 8 z" class="dg-arrowhead"></path>
    </marker>
  </defs>
  <g class="dg-actors">${actorSvg}</g>
  <g class="dg-messages">${messages}</g>
</svg>`;
}

/** Longest-path layering for a DAG. Cycles fall back to the node's current rank. */
function assignRanks(diagram: Diagram): Map<string, number> {
  const rank = new Map<string, number>();
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of diagram.nodes) {
    rank.set(node.id, 0);
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of diagram.edges) {
    if (!rank.has(edge.from) || !rank.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      const remaining = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  // A cycle is not expected in editorial diagrams. If one slips through, put the
  // remaining nodes in a final column so the drawing stays finite.
  if (visited.size !== diagram.nodes.length) {
    const fallback = Math.max(...rank.values(), 0) + 1;
    for (const node of diagram.nodes) {
      if (!visited.has(node.id)) rank.set(node.id, fallback);
    }
  }

  return rank;
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function shortHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
