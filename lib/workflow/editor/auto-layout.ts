import { sourceHandleRank } from "@/lib/workflow/source-handles";

// Local structural types instead of importing @xyflow/react, so this pure
// layout helper can also run server-side (e.g. seeding onboarding workflow
// fixtures). Real @xyflow/react Node/Edge are structural supersets, so editor
// callers pass them without a cast.
type Node = {
  id: string;
  type?: string;
  position: { x: number; y: number };
};
type Edge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

const NODE_WIDTH = 192;
const NODE_HEIGHT = 192;
const H_GAP = 60;
const V_GAP = 40;

const COLUMN_STEP = NODE_WIDTH + H_GAP;
const ROW_STEP = NODE_HEIGHT + V_GAP;

// Two sweeps are enough to pull parents onto their children and children back
// under their parents; more passes stop changing the picture.
const REFINE_PASSES = 2;

// An edge with no named handle sits between the upper and the lower handle.
const UNNAMED_RANK = 0.5;

/**
 * Order outgoing edges the way their handles sit on the node: the upper handle
 * (true, done) first, then edges with no named handle, then the lower one
 * (false, loop). Sorting is stable, so edges sharing a handle keep their order.
 */
function sortEdges(edges: Edge[]): Edge[] {
  return [...edges].sort(
    (a, b) =>
      (sourceHandleRank(a.sourceHandle) ?? UNNAMED_RANK) -
      (sourceHandleRank(b.sourceHandle) ?? UNNAMED_RANK)
  );
}

/** Walk the trigger first, then unreferenced nodes, then anything left on a cycle. */
function walkOrder(realNodes: Node[], targets: Set<string>): string[] {
  const start: string[] = [];
  const trigger = realNodes.find((n) => n.type === "trigger");
  if (trigger) {
    start.push(trigger.id);
  }
  for (const node of realNodes) {
    if (!(targets.has(node.id) || start.includes(node.id))) {
      start.push(node.id);
    }
  }
  for (const node of realNodes) {
    if (!start.includes(node.id)) {
      start.push(node.id);
    }
  }
  return start;
}

/**
 * Drop self edges, duplicates and back edges so the rest of the layout works on
 * a DAG. A back edge points at a node still open on the DFS stack, which is the
 * edge that closes a loop back onto its own body.
 */
function forwardEdgesOf(realNodes: Node[], edges: Edge[]): Edge[] {
  const realIds = new Set(realNodes.map((n) => n.id));
  const candidates: Edge[] = [];
  const seen = new Set<string>();
  const targets = new Set<string>();

  for (const edge of edges) {
    const key = `${edge.source}->${edge.target}`;
    if (
      edge.source === edge.target ||
      !(realIds.has(edge.source) && realIds.has(edge.target)) ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    candidates.push(edge);
    targets.add(edge.target);
  }

  const bySource = new Map<string, Edge[]>();
  for (const edge of candidates) {
    const list = bySource.get(edge.source);
    if (list) {
      list.push(edge);
    } else {
      bySource.set(edge.source, [edge]);
    }
  }

  const backEdges = new Set<string>();
  const open = new Set<string>();
  const done = new Set<string>();

  const visit = (nodeId: string): void => {
    open.add(nodeId);
    for (const edge of sortEdges(bySource.get(nodeId) ?? [])) {
      if (open.has(edge.target)) {
        backEdges.add(`${edge.source}->${edge.target}`);
      } else if (!done.has(edge.target)) {
        visit(edge.target);
      }
    }
    open.delete(nodeId);
    done.add(nodeId);
  };

  for (const nodeId of walkOrder(realNodes, targets)) {
    if (!done.has(nodeId)) {
      visit(nodeId);
    }
  }

  return candidates.filter((e) => !backEdges.has(`${e.source}->${e.target}`));
}

type Graph = {
  children: Map<string, string[]>;
  parents: Map<string, string[]>;
  inDegree: Map<string, number>;
  /** Where the edge leaves its source, keyed "source->target". */
  edgeRank: Map<string, number>;
};

function buildGraph(realNodes: Node[], forwardEdges: Edge[]): Graph {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const edgeRank = new Map<string, number>();

  for (const node of realNodes) {
    children.set(node.id, []);
    parents.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  const bySource = new Map<string, Edge[]>();
  for (const edge of forwardEdges) {
    const list = bySource.get(edge.source);
    if (list) {
      list.push(edge);
    } else {
      bySource.set(edge.source, [edge]);
    }
  }

  for (const node of realNodes) {
    for (const edge of sortEdges(bySource.get(node.id) ?? [])) {
      children.get(node.id)?.push(edge.target);
      parents.get(edge.target)?.push(node.id);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
      edgeRank.set(
        `${node.id}->${edge.target}`,
        sourceHandleRank(edge.sourceHandle) ?? UNNAMED_RANK
      );
    }
  }

  return { children, parents, inDegree, edgeRank };
}

function findRoots(realNodes: Node[], inDegree: Map<string, number>): string[] {
  const roots: string[] = [];
  const trigger = realNodes.find((n) => n.type === "trigger");

  if (trigger && inDegree.get(trigger.id) === 0) {
    roots.push(trigger.id);
  }

  for (const node of realNodes) {
    if (inDegree.get(node.id) === 0 && !roots.includes(node.id)) {
      roots.push(node.id);
    }
  }

  return roots;
}

/**
 * Assign columns using longest-path from roots (topological order), so a node
 * always sits to the right of every node that feeds it.
 */
function assignColumns(roots: string[], graph: Graph): Map<string, number> {
  const column = new Map<string, number>();
  const remaining = new Map(graph.inDegree);
  const queue = [...roots];

  for (const root of roots) {
    column.set(root, 0);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const nextCol = (column.get(current) ?? 0) + 1;

    for (const child of graph.children.get(current) ?? []) {
      if (nextCol > (column.get(child) ?? Number.NEGATIVE_INFINITY)) {
        column.set(child, nextCol);
      }
      const rem = (remaining.get(child) ?? 1) - 1;
      remaining.set(child, rem);
      if (rem <= 0) {
        queue.push(child);
      }
    }
  }

  for (const node of graph.children.keys()) {
    if (!column.has(node)) {
      column.set(node, 0);
    }
  }

  return column;
}

/**
 * The branch turns taken to reach a node, one entry per step: which root it
 * came from, then where each edge left its source. Comparing two of these
 * decides which node belongs higher in a column, so a true branch stays above
 * a false branch even where the two meet nodes placed from another path.
 *
 * A node is reached through the parent that fixed its column, which is the one
 * furthest right; nodes on a cycle with no path from a root sort last.
 */
function branchPaths(
  realNodes: Node[],
  roots: string[],
  graph: Graph,
  columns: Map<string, number>
): Map<string, number[]> {
  const paths = new Map<string, number[]>();
  for (const [index, root] of roots.entries()) {
    paths.set(root, [index]);
  }

  const byColumn: string[][] = [];
  for (const node of realNodes) {
    const col = columns.get(node.id) ?? 0;
    byColumn[col] = byColumn[col] ?? [];
    byColumn[col].push(node.id);
  }

  for (const ids of byColumn) {
    for (const id of ids ?? []) {
      if (paths.has(id)) {
        continue;
      }
      let from: string | undefined;
      let fromColumn = Number.NEGATIVE_INFINITY;
      for (const parent of graph.parents.get(id) ?? []) {
        const col = columns.get(parent) ?? 0;
        if (paths.has(parent) && col > fromColumn) {
          from = parent;
          fromColumn = col;
        }
      }
      const parentPath = from === undefined ? undefined : paths.get(from);
      if (parentPath) {
        paths.set(id, [
          ...parentPath,
          graph.edgeRank.get(`${from}->${id}`) ?? UNNAMED_RANK,
        ]);
      }
    }
  }

  for (const node of realNodes) {
    if (!paths.has(node.id)) {
      paths.set(node.id, [Number.POSITIVE_INFINITY]);
    }
  }

  return paths;
}

function comparePaths(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

/**
 * Vertical order of each column: upper branches first, and within a branch the
 * order the nodes were declared.
 */
function orderColumns(
  realNodes: Node[],
  roots: string[],
  graph: Graph,
  columns: Map<string, number>
): string[][] {
  const paths = branchPaths(realNodes, roots, graph, columns);
  const order: string[][] = [];
  const seq = new Map<string, number>();

  for (const [index, node] of realNodes.entries()) {
    const col = columns.get(node.id) ?? 0;
    order[col] = order[col] ?? [];
    order[col].push(node.id);
    seq.set(node.id, index);
  }

  for (let col = 0; col < order.length; col++) {
    order[col] = (order[col] ?? []).sort((a, b) => {
      const byPath = comparePaths(paths.get(a) ?? [], paths.get(b) ?? []);
      return byPath === 0 ? (seq.get(a) ?? 0) - (seq.get(b) ?? 0) : byPath;
    });
  }

  return order;
}

/** Average row of the neighbours that already have one. */
function averageRow(
  neighbours: string[],
  rows: Map<string, number>
): number | undefined {
  let sum = 0;
  let count = 0;
  for (const id of neighbours) {
    const row = rows.get(id);
    if (row !== undefined) {
      sum += row;
      count++;
    }
  }
  return count > 0 ? sum / count : undefined;
}

/**
 * Write one column's rows, keeping every node at least a full node height
 * apart. Packing can only push nodes down, so the column is shifted back up by
 * the average displacement and stays centred on where its nodes wanted to be.
 */
function packColumn(
  ids: string[],
  targets: number[],
  rows: Map<string, number>
): void {
  const packed: number[] = [];
  let drift = 0;

  for (let i = 0; i < ids.length; i++) {
    const min = packed[i - 1] + ROW_STEP;
    const row = i === 0 ? targets[i] : Math.max(targets[i], min);
    packed.push(row);
    drift += row - targets[i];
  }

  const shift = ids.length > 0 ? drift / ids.length : 0;
  for (let i = 0; i < ids.length; i++) {
    rows.set(ids[i], packed[i] - shift);
  }
}

/**
 * First pass: sweep left to right, hanging each node off its parents. Every
 * parent lives in a lower column, so it always has a row by the time its
 * children are placed.
 */
function seedRows(order: string[][], graph: Graph): Map<string, number> {
  const rows = new Map<string, number>();

  for (const ids of order) {
    const targets: number[] = [];
    let previous: number | undefined;
    for (const id of ids) {
      const fromParents = averageRow(graph.parents.get(id) ?? [], rows);
      const target =
        fromParents ?? (previous === undefined ? 0 : previous + ROW_STEP);
      targets.push(target);
      previous = target;
    }
    packColumn(ids, targets, rows);
  }

  return rows;
}

/**
 * Later passes: pull each node onto the average of its children (right to
 * left), then back onto the average of its parents (left to right). This is
 * what centres a branch node between its branches and a join node between the
 * paths that feed it.
 */
function refineRows(
  order: string[][],
  graph: Graph,
  rows: Map<string, number>
): void {
  const sweep = (
    columnIds: string[],
    neighboursOf: (id: string) => string[]
  ): void => {
    const targets = columnIds.map(
      (id) => averageRow(neighboursOf(id), rows) ?? rows.get(id) ?? 0
    );
    packColumn(columnIds, targets, rows);
  };

  for (let pass = 0; pass < REFINE_PASSES; pass++) {
    for (let col = order.length - 1; col >= 0; col--) {
      sweep(order[col], (id) => graph.children.get(id) ?? []);
    }
    for (const ids of order) {
      sweep(ids, (id) => graph.parents.get(id) ?? []);
    }
  }
}

/**
 * Compute a clean left-to-right DAG layout for workflow nodes.
 *
 * - Columns via longest-path topological sort (handles convergence)
 * - Rows via a layered sweep that keeps every column free of overlap
 * - Branches follow their handles: true/done above, false/loop below
 * - Loop bodies lay out to the right of their For Each node; only the edges
 *   that close a cycle are ignored
 */
export function computeAutoLayout(
  nodes: Node[],
  edges: Edge[]
): Map<string, { x: number; y: number }> {
  const realNodes = nodes.filter((n) => n.type !== "add");
  const forwardEdges = forwardEdgesOf(realNodes, edges);
  const graph = buildGraph(realNodes, forwardEdges);
  const roots = findRoots(realNodes, graph.inDegree);
  const columns = assignColumns(roots, graph);
  const order = orderColumns(realNodes, roots, graph, columns);

  const rows = seedRows(order, graph);
  refineRows(order, graph, rows);

  let topRow = Number.POSITIVE_INFINITY;
  for (const row of rows.values()) {
    topRow = Math.min(topRow, row);
  }
  const offset = Number.isFinite(topRow) ? topRow : 0;

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of realNodes) {
    positions.set(node.id, {
      x: (columns.get(node.id) ?? 0) * COLUMN_STEP,
      y: Math.round((rows.get(node.id) ?? 0) - offset),
    });
  }

  return positions;
}
