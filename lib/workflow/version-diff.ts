/**
 * Human-readable semantic diff between two workflow snapshots, for the version
 * history UI. Compares nodes by id and edges by connectivity, ignoring cosmetic
 * canvas state (node position, selection) so a drag never shows as a change.
 * This replaces a raw JSON diff -- it answers "what changed", not "which bytes
 * differ".
 */

type AnyRecord = Record<string, unknown>;

type Snapshotish = {
  name?: string | null;
  description?: string | null;
  visibility?: string | null;
  enabled?: boolean | null;
  nodes?: unknown;
  edges?: unknown;
};

export type SettingChange = {
  field: "name" | "description" | "visibility" | "enabled";
  before: string;
  after: string;
};

export type NodeRef = { id: string; label: string; nodeType: string };

export type NodeFieldDelta = {
  field: "name" | "description" | "type" | "configuration" | "enabled";
  before?: string;
  after?: string;
  configKeys?: string[];
};

export type NodeFieldChange = {
  id: string;
  label: string;
  nodeType: string;
  deltas: NodeFieldDelta[];
};

export type ConnectionRef = { from: string; to: string };

export type VersionDiff = {
  settings: SettingChange[];
  nodesAdded: NodeRef[];
  nodesRemoved: NodeRef[];
  nodesChanged: NodeFieldChange[];
  connectionsAdded: ConnectionRef[];
  connectionsRemoved: ConnectionRef[];
  hasChanges: boolean;
};

function asArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? (value as AnyRecord[]) : [];
}

function nodeLabel(node: AnyRecord): string {
  const data = (node.data ?? {}) as AnyRecord;
  const label = typeof data.label === "string" ? data.label.trim() : "";
  if (label) {
    return label;
  }
  const type = typeof data.type === "string" ? data.type : undefined;
  const kind =
    typeof (data.config as AnyRecord)?.triggerType === "string"
      ? ((data.config as AnyRecord).triggerType as string)
      : undefined;
  return kind || type || (typeof node.type === "string" ? node.type : "node");
}

function nodeType(node: AnyRecord): string {
  const data = (node.data ?? {}) as AnyRecord;
  if (typeof data.type === "string") {
    return data.type;
  }
  return typeof node.type === "string" ? node.type : "step";
}

function byId(nodes: AnyRecord[]): Map<string, AnyRecord> {
  const map = new Map<string, AnyRecord>();
  for (const n of nodes) {
    if (typeof n.id === "string") {
      map.set(n.id, n);
    }
  }
  return map;
}

function changedConfigKeys(before: AnyRecord, after: AnyRecord): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed.push(key);
    }
  }
  return changed;
}

function buildNodeDeltas(
  before: AnyRecord,
  after: AnyRecord
): NodeFieldDelta[] {
  const bd = (before.data ?? {}) as AnyRecord;
  const ad = (after.data ?? {}) as AnyRecord;
  const deltas: NodeFieldDelta[] = [];

  const bLabel = typeof bd.label === "string" ? bd.label : "";
  const aLabel = typeof ad.label === "string" ? ad.label : "";
  if (bLabel !== aLabel) {
    deltas.push({ field: "name", before: bLabel, after: aLabel });
  }

  const bDesc = typeof bd.description === "string" ? bd.description : "";
  const aDesc = typeof ad.description === "string" ? ad.description : "";
  if (bDesc !== aDesc) {
    deltas.push({ field: "description", before: bDesc, after: aDesc });
  }

  if (nodeType(before) !== nodeType(after)) {
    deltas.push({
      field: "type",
      before: nodeType(before),
      after: nodeType(after),
    });
  }

  const bConfig = (bd.config ?? {}) as AnyRecord;
  const aConfig = (ad.config ?? {}) as AnyRecord;
  const configKeys = changedConfigKeys(bConfig, aConfig);
  if (configKeys.length > 0) {
    deltas.push({ field: "configuration", configKeys });
  }

  const bEnabled = bd.enabled ?? true;
  const aEnabled = ad.enabled ?? true;
  if (bEnabled !== aEnabled) {
    deltas.push({
      field: "enabled",
      before: String(bEnabled),
      after: String(aEnabled),
    });
  }

  return deltas;
}

function edgeKey(edge: AnyRecord): string {
  return [
    edge.source,
    edge.target,
    edge.sourceHandle ?? "",
    edge.targetHandle ?? "",
  ].join("|");
}

function connectionRef(
  edge: AnyRecord,
  labels: Map<string, string>
): ConnectionRef {
  const from = labels.get(String(edge.source)) ?? String(edge.source);
  const to = labels.get(String(edge.target)) ?? String(edge.target);
  return { from, to };
}

function diffSettings(
  before: Snapshotish,
  after: Snapshotish
): SettingChange[] {
  const out: SettingChange[] = [];
  const fields: SettingChange["field"][] = [
    "name",
    "description",
    "visibility",
    "enabled",
  ];
  for (const field of fields) {
    const b = before[field] ?? "";
    const a = after[field] ?? "";
    if (String(b) !== String(a)) {
      out.push({ field, before: String(b), after: String(a) });
    }
  }
  return out;
}

export function computeVersionDiff(
  before: Snapshotish | null,
  after: Snapshotish
): VersionDiff {
  const empty: VersionDiff = {
    settings: [],
    nodesAdded: [],
    nodesRemoved: [],
    nodesChanged: [],
    connectionsAdded: [],
    connectionsRemoved: [],
    hasChanges: false,
  };
  if (!before) {
    return empty;
  }

  const beforeNodes = byId(asArray(before.nodes));
  const afterNodes = byId(asArray(after.nodes));

  const nodesAdded: NodeRef[] = [];
  const nodesRemoved: NodeRef[] = [];
  const nodesChanged: NodeFieldChange[] = [];

  for (const [id, node] of afterNodes) {
    const prev = beforeNodes.get(id);
    if (!prev) {
      nodesAdded.push({ id, label: nodeLabel(node), nodeType: nodeType(node) });
      continue;
    }
    const deltas = buildNodeDeltas(prev, node);
    if (deltas.length > 0) {
      nodesChanged.push({
        id,
        label: nodeLabel(node),
        nodeType: nodeType(node),
        deltas,
      });
    }
  }
  for (const [id, node] of beforeNodes) {
    if (!afterNodes.has(id)) {
      nodesRemoved.push({
        id,
        label: nodeLabel(node),
        nodeType: nodeType(node),
      });
    }
  }

  // Connection labels resolve to the node's display name in whichever snapshot
  // knows it (after preferred, before as fallback for removed connections).
  const labels = new Map<string, string>();
  for (const [id, n] of beforeNodes) {
    labels.set(id, nodeLabel(n));
  }
  for (const [id, n] of afterNodes) {
    labels.set(id, nodeLabel(n));
  }

  const beforeEdges = new Map(
    asArray(before.edges).map((e) => [edgeKey(e), e])
  );
  const afterEdges = new Map(asArray(after.edges).map((e) => [edgeKey(e), e]));
  const connectionsAdded: ConnectionRef[] = [];
  const connectionsRemoved: ConnectionRef[] = [];
  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) {
      connectionsAdded.push(connectionRef(edge, labels));
    }
  }
  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) {
      connectionsRemoved.push(connectionRef(edge, labels));
    }
  }

  const settings = diffSettings(before, after);
  const hasChanges =
    settings.length > 0 ||
    nodesAdded.length > 0 ||
    nodesRemoved.length > 0 ||
    nodesChanged.length > 0 ||
    connectionsAdded.length > 0 ||
    connectionsRemoved.length > 0;

  return {
    settings,
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    connectionsAdded,
    connectionsRemoved,
    hasChanges,
  };
}
