// Control UI view renders the memory graph dashboard.
import { html, nothing, svg, type TemplateResult } from "lit";
import type { DreamingEntry, WikiOverview } from "./dreaming.ts";
import "../../../styles/memory-graph.css";

type MemoryGraphAgentOption = {
  id: string;
  label: string;
};

export type MemoryGraphProps = {
  viewState: MemoryGraphViewState;
  selectedAgentId: string;
  agentOptions: MemoryGraphAgentOption[];
  loading: boolean;
  statusError: string | null;
  wikiLoading: boolean;
  wikiError: string | null;
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  shortTermCount: number;
  promotedTotal: number;
  totalSignalCount: number;
  wikiOverview: WikiOverview | null;
  onRefresh: () => void;
  onSelectAgent: (agentId: string) => void;
  onOpenDreaming: () => void;
  onRequestUpdate?: () => void;
};

type GraphNodeKind = "root" | "cluster" | "short-term" | "promoted" | "wiki" | "claim" | "question";

type GraphNode = {
  id: string;
  label: string;
  title: string;
  kind: GraphNodeKind;
  group: string;
  detail: string;
  metric?: number;
};

type GraphEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
};

type PositionedNode = GraphNode & {
  x: number;
  y: number;
};

type GraphModel = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type GraphLayout = {
  nodes: PositionedNode[];
  edges: GraphEdge[];
};

export type MemoryGraphViewState = { search: string; selectedNodeId: string | null };
export function createMemoryGraphViewState(): MemoryGraphViewState {
  return { search: "", selectedNodeId: null };
}

const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 560;
const MAX_DREAMING_NODES = 30;
const MAX_WIKI_ITEMS_PER_CLUSTER = 18;
const MAX_WIKI_FACTS_PER_ITEM = 2;

function truncate(value: string, max: number): string {
  const compact = value.trim().replace(/\s+/g, " ");
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const NODE_RADIUS_BY_KIND: Record<GraphNodeKind, number> = {
  root: 30,
  cluster: 23,
  promoted: 16,
  "short-term": 13,
  wiki: 14,
  claim: 9,
  question: 9,
};

function nodeRadius(node: GraphNode): number {
  return NODE_RADIUS_BY_KIND[node.kind];
}

function nodeClass(node: GraphNode, selectedId: string | null, query: string): string {
  const normalizedQuery = query.trim().toLowerCase();
  const matches =
    normalizedQuery.length > 0 &&
    `${node.label} ${node.title} ${node.detail}`.toLowerCase().includes(normalizedQuery);
  return [
    "memory-graph-node",
    `memory-graph-node--${node.kind}`,
    selectedId === node.id ? "memory-graph-node--selected" : "",
    matches ? "memory-graph-node--match" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function addUniqueNode(nodes: GraphNode[], seen: Set<string>, node: GraphNode): void {
  if (seen.has(node.id)) {
    return;
  }
  seen.add(node.id);
  nodes.push(node);
}

function addEdge(edges: GraphEdge[], from: string, to: string, label?: string): void {
  edges.push({ id: `${from}->${to}:${edges.length}`, from, to, ...(label ? { label } : {}) });
}

function entryNode(entry: DreamingEntry, kind: "short-term" | "promoted"): GraphNode {
  const score = entry.totalSignalCount + entry.recallCount + entry.phaseHitCount;
  return {
    id: `${kind}:${entry.key}`,
    label: truncate(entry.snippet, 34),
    title: entry.path,
    kind,
    group: kind === "promoted" ? "Promoted" : "Short Term",
    detail: [
      entry.snippet,
      `Signals ${entry.totalSignalCount}`,
      `Recall ${entry.recallCount}`,
      `Lines ${entry.startLine}-${entry.endLine}`,
    ].join("\n"),
    metric: score,
  };
}

function buildGraphModel(props: MemoryGraphProps): GraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  addUniqueNode(nodes, seen, {
    id: "memory",
    label: "Memory",
    title: "OpenClaw Memory",
    kind: "root",
    group: "Root",
    detail: "Short-term signals, promoted memories, and memory-wiki pages for the selected agent.",
    metric: props.shortTermCount + props.promotedTotal + (props.wikiOverview?.totalItems ?? 0),
  });

  const clusterNodes: GraphNode[] = [
    {
      id: "cluster:short-term",
      label: "Short Term",
      title: "Short-term candidates",
      kind: "cluster",
      group: "Clusters",
      detail: `${props.shortTermCount} short-term candidates. ${props.totalSignalCount} total signals.`,
      metric: props.shortTermCount,
    },
    {
      id: "cluster:promoted",
      label: "Promoted",
      title: "Promoted memories",
      kind: "cluster",
      group: "Clusters",
      detail: `${props.promotedTotal} promoted memories.`,
      metric: props.promotedTotal,
    },
    {
      id: "cluster:wiki",
      label: "Wiki Palace",
      title: "Memory wiki palace",
      kind: "cluster",
      group: "Clusters",
      detail: `${props.wikiOverview?.totalItems ?? 0} wiki memory items.`,
      metric: props.wikiOverview?.totalItems ?? 0,
    },
  ];

  for (const cluster of clusterNodes) {
    addUniqueNode(nodes, seen, cluster);
    addEdge(edges, "memory", cluster.id);
  }

  const shortEntries = props.shortTermEntries.slice(0, MAX_DREAMING_NODES);
  for (const entry of shortEntries) {
    const node = entryNode(entry, "short-term");
    addUniqueNode(nodes, seen, node);
    addEdge(edges, "cluster:short-term", node.id, "waiting");
  }

  const promotedEntries = props.promotedEntries.slice(0, MAX_DREAMING_NODES);
  for (const entry of promotedEntries) {
    const node = entryNode(entry, "promoted");
    addUniqueNode(nodes, seen, node);
    addEdge(edges, "cluster:promoted", node.id, "promoted");
    const shortId = `short-term:${entry.key}`;
    if (seen.has(shortId)) {
      addEdge(edges, shortId, node.id, "promotes");
    }
  }

  for (const cluster of props.wikiOverview?.clusters ?? []) {
    const clusterId = `wiki-cluster:${cluster.key}`;
    addUniqueNode(nodes, seen, {
      id: clusterId,
      label: cluster.label,
      title: cluster.label,
      kind: "cluster",
      group: "Wiki",
      detail: `${cluster.itemCount} pages. ${cluster.claimCount} claims, ${cluster.questionCount} questions, ${cluster.contradictionCount} contradictions.`,
      metric: cluster.itemCount,
    });
    addEdge(edges, "cluster:wiki", clusterId, cluster.key);

    for (const item of cluster.items.slice(0, MAX_WIKI_ITEMS_PER_CLUSTER)) {
      const itemId = `wiki:${item.pagePath}`;
      addUniqueNode(nodes, seen, {
        id: itemId,
        label: truncate(item.title, 30),
        title: item.title,
        kind: "wiki",
        group: cluster.label,
        detail:
          item.snippet ??
          `${item.claimCount} claims, ${item.questionCount} questions, ${item.contradictionCount} contradictions.`,
        metric: item.claimCount + item.questionCount + item.contradictionCount,
      });
      addEdge(edges, clusterId, itemId, item.kind);

      for (const [index, claim] of item.claims.slice(0, MAX_WIKI_FACTS_PER_ITEM).entries()) {
        const claimId = `claim:${item.pagePath}:${index}`;
        addUniqueNode(nodes, seen, {
          id: claimId,
          label: truncate(claim, 24),
          title: "Claim",
          kind: "claim",
          group: "Claims",
          detail: claim,
        });
        addEdge(edges, itemId, claimId, "claim");
      }

      for (const [index, question] of item.questions.slice(0, MAX_WIKI_FACTS_PER_ITEM).entries()) {
        const questionId = `question:${item.pagePath}:${index}`;
        addUniqueNode(nodes, seen, {
          id: questionId,
          label: truncate(question, 24),
          title: "Question",
          kind: "question",
          group: "Questions",
          detail: question,
        });
        addEdge(edges, itemId, questionId, "question");
      }
    }
  }

  return { nodes, edges };
}

function layoutGraph(model: GraphModel): GraphLayout {
  const columns: Array<{ kinds: GraphNodeKind[]; x: number; top: number; bottom: number }> = [
    { kinds: ["short-term"], x: 170, top: 245, bottom: 515 },
    { kinds: ["promoted"], x: 390, top: 245, bottom: 515 },
    { kinds: ["wiki"], x: 620, top: 235, bottom: 505 },
    { kinds: ["claim", "question"], x: 835, top: 235, bottom: 505 },
  ];
  const positioned = new Map<string, PositionedNode>();

  const place = (node: GraphNode, x: number, y: number) => {
    positioned.set(node.id, { ...node, x, y });
  };

  const get = (id: string) => model.nodes.find((node) => node.id === id);
  const root = get("memory");
  if (root) {
    place(root, GRAPH_WIDTH / 2, 54);
  }

  const topClusters = model.nodes.filter(
    (node) => node.kind === "cluster" && node.id.startsWith("cluster:"),
  );
  topClusters.forEach((node, index) => place(node, 235 + index * 265, 145));

  const wikiClusters = model.nodes.filter(
    (node) => node.kind === "cluster" && node.id.startsWith("wiki-cluster:"),
  );
  wikiClusters.forEach((node, index) => place(node, 620, 230 + index * 58));

  for (const column of columns) {
    const nodes = model.nodes.filter(
      (node) => column.kinds.includes(node.kind) && !positioned.has(node.id),
    );
    const step = nodes.length <= 1 ? 0 : (column.bottom - column.top) / (nodes.length - 1);
    nodes.forEach((node, index) => {
      const stagger = index % 2 === 0 ? -18 : 18;
      place(node, column.x + stagger, column.top + step * index);
    });
  }

  for (const node of model.nodes) {
    if (!positioned.has(node.id)) {
      place(node, GRAPH_WIDTH / 2, GRAPH_HEIGHT / 2);
    }
  }

  return { nodes: [...positioned.values()], edges: model.edges };
}

function selectedNode(layout: GraphLayout, props: MemoryGraphProps): PositionedNode | null {
  return (
    layout.nodes.find((node) => node.id === props.viewState.selectedNodeId) ??
    layout.nodes[0] ??
    null
  );
}

function renderStats(props: MemoryGraphProps, model: GraphModel): TemplateResult {
  return html`
    <div class="memory-graph-stats" aria-label="Memory graph statistics">
      <div class="memory-graph-stat">
        <strong>${model.nodes.length}</strong>
        <span>Nodes</span>
      </div>
      <div class="memory-graph-stat">
        <strong>${model.edges.length}</strong>
        <span>Edges</span>
      </div>
      <div class="memory-graph-stat">
        <strong>${props.shortTermCount}</strong>
        <span>Short Term</span>
      </div>
      <div class="memory-graph-stat">
        <strong>${props.promotedTotal}</strong>
        <span>Promoted</span>
      </div>
      <div class="memory-graph-stat">
        <strong>${props.wikiOverview?.totalItems ?? 0}</strong>
        <span>Wiki Items</span>
      </div>
    </div>
  `;
}

function renderGraph(layout: GraphLayout, props: MemoryGraphProps): TemplateResult {
  const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
  return html`
    <div class="memory-graph-canvas" role="img" aria-label="Interactive memory graph">
      ${svg`<svg viewBox=${`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
        <g class="memory-graph-edges">
          ${layout.edges.map((edge) => {
            const from = nodesById.get(edge.from);
            const to = nodesById.get(edge.to);
            if (!from || !to) {
              return nothing;
            }
            return svg`
              <line
                class="memory-graph-edge"
                x1=${from.x}
                y1=${from.y}
                x2=${to.x}
                y2=${to.y}
              ></line>
            `;
          })}
        </g>
        <g class="memory-graph-nodes">
          ${layout.nodes.map(
            (node) => svg`
              <g
                class=${nodeClass(node, props.viewState.selectedNodeId, props.viewState.search)}
                tabindex="0"
                role="button"
                aria-label=${`${node.group}: ${node.label}`}
                transform=${`translate(${node.x} ${node.y})`}
                @click=${() => {
                  props.viewState.selectedNodeId = node.id;
                  props.onRequestUpdate?.();
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  props.viewState.selectedNodeId = node.id;
                  props.onRequestUpdate?.();
                }}
              >
                <circle r=${nodeRadius(node)}></circle>
                <text y=${nodeRadius(node) + 16}>${node.label}</text>
              </g>
            `,
          )}
        </g>
      </svg>`}
    </div>
  `;
}

function renderDetails(node: PositionedNode | null): TemplateResult {
  if (!node) {
    return html`
      <aside class="memory-graph-detail">
        <p class="muted">Select a node to inspect details.</p>
      </aside>
    `;
  }
  return html`
    <aside class="memory-graph-detail">
      <div class="memory-graph-detail__eyebrow">${node.group}</div>
      <h2>${node.title}</h2>
      <p>${node.detail}</p>
      ${
        node.metric !== undefined
          ? html`
              <div class="memory-graph-detail__metric">
                <strong>${node.metric}</strong>
                <span>Signal</span>
              </div>
            `
          : nothing
      }
    </aside>
  `;
}

function renderMatches(
  layout: GraphLayout,
  query: string,
  props: MemoryGraphProps,
): TemplateResult {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return html`<p class="muted">Search highlights matching node labels and details.</p>`;
  }
  const matches = layout.nodes.filter((node) =>
    `${node.label} ${node.title} ${node.detail}`.toLowerCase().includes(normalizedQuery),
  );
  if (matches.length === 0) {
    return html`<p class="muted">No memory graph nodes match that search.</p>`;
  }
  return html`
    <div class="memory-graph-matches">
      ${matches.slice(0, 10).map(
        (node) => html`
          <button
            class="memory-graph-match"
            type="button"
            @click=${() => {
              props.viewState.selectedNodeId = node.id;
              props.onRequestUpdate?.();
            }}
          >
            <span>${node.label}</span>
            <small>${node.group}</small>
          </button>
        `,
      )}
    </div>
  `;
}

export function renderMemoryGraph(props: MemoryGraphProps): TemplateResult {
  const model = buildGraphModel(props);
  const layout = layoutGraph(model);
  const detail = selectedNode(layout, props);
  const busy = props.loading || props.wikiLoading;
  return html`
    <section class="memory-graph">
      <div class="memory-graph-toolbar">
        <div class="memory-graph-toolbar__filters">
          <label class="memory-graph-field">
            <span>Agent</span>
            <select
              class="input"
              .value=${props.selectedAgentId}
              @change=${(event: Event) => {
                const target = event.currentTarget;
                if (!(target instanceof HTMLSelectElement)) {
                  return;
                }
                const value = target.value;
                props.viewState.selectedNodeId = null;
                props.onSelectAgent(value);
              }}
            >
              ${props.agentOptions.map(
                (agent) => html`<option value=${agent.id}>${agent.label}</option>`,
              )}
            </select>
          </label>
          <label class="memory-graph-field memory-graph-field--search">
            <span>Search</span>
            <input
              class="input"
              type="search"
              placeholder="Search nodes..."
              .value=${props.viewState.search}
              @input=${(event: Event) => {
                const target = event.currentTarget;
                if (!(target instanceof HTMLInputElement)) {
                  return;
                }
                props.viewState.search = target.value;
                props.onRequestUpdate?.();
              }}
            />
          </label>
        </div>
        <div class="memory-graph-toolbar__actions">
          <button class="btn btn--subtle btn--sm" ?disabled=${busy} @click=${props.onOpenDreaming}>
            Open Dreaming
          </button>
          <button class="btn btn--sm" ?disabled=${busy} @click=${props.onRefresh}>
            ${busy ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      ${
        props.statusError || props.wikiError
          ? html`
              <div class="callout danger" role="alert">${props.statusError ?? props.wikiError}</div>
            `
          : nothing
      }
      ${renderStats(props, model)}

      <div class="memory-graph-layout">
        <div class="memory-graph-main">
          ${
            model.nodes.length > 1
              ? renderGraph(layout, props)
              : html`
                  <div class="memory-graph-empty">
                    <h2>No memory graph data yet</h2>
                    <p>
                      Enable memory dreaming or memory-wiki to populate short-term, promoted, and
                      wiki graph nodes.
                    </p>
                  </div>
                `
          }
          ${renderMatches(layout, props.viewState.search, props)}
        </div>
        ${renderDetails(detail)}
      </div>
    </section>
  `;
}
