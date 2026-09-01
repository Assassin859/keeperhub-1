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

/** Order outgoing edges: true/loop first, normal next, false/done last. */
function sortEdges(edges: Edge[]): Edge[] {
  const top: Edge[] = [];
  const normal: Edge[] = [];
  const bottom: Edge[] = [];

  for (const edge of edges) {
    const handle = edge.sourceHandle;
    if (handle === "true" || handle === "loop") {
      top.push(edge);
    } else if (handle === "false" || handle === "done") {
      bottom.push(edge);
    } else {
      normal.push(edge);
    }
  }

  return [...top, ...normal, ...bottom];
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
};

function buildGraph(realNodes: Node[], forwardEdges: Edge[]): Graph {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

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
    }
  }

  return { children, parents, inDegree };
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
 * Vertical order of each column, taken from a depth-first walk of the graph so
 * that a branch and everything below it stay together, true/loop above
 * false/done.
 */
function orderColumns(
  realNodes: Node[],
  roots: string[],
  graph: Graph,
  columns: Map<string, number>
): string[][] {
  const order: string[][] = [];
  const seen = new Set<string>();

  const push = (nodeId: string): void => {
    const col = columns.get(nodeId) ?? 0;
    const list = order[col];
    if (list) {
      list.push(nodeId);
    } else {
      order[col] = [nodeId];
    }
  };

  const visit = (nodeId: string): void => {
    if (seen.has(nodeId)) {
      return;
    }
    seen.add(nodeId);
    push(nodeId);
    for (const child of graph.children.get(nodeId) ?? []) {
      visit(child);
    }
  };

  for (const root of roots) {
    visit(root);
  }
  for (const node of realNodes) {
    visit(node.id);
  }

  for (let col = 0; col < order.length; col++) {
    order[col] ??= [];
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
 * - Edge ordering: true/loop on top, false/done on bottom
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
