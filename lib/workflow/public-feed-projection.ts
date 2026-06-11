/**
 * Public marketplace feed projection.
 *
 * The unauthenticated `/api/workflows/public` feed renders a minimap and node
 * icons from each workflow's graph, so it needs node positions and the node /
 * action type, but it must never expose node config (parameters, addresses,
 * message bodies, endpoints, integrationId, or any embedded secret) to
 * anonymous callers. These projections are allowlists: any field not named
 * here is absent by default, so a new node-config field cannot leak later
 * without an explicit change.
 */

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

/**
 * Keep only the node fields the feed renders: id, type, position, and the
 * node/action/trigger type used to pick an icon. All other config is dropped.
 */
export function projectNodesForPublicFeed(nodes: unknown): UnknownRecord[] {
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes.map((raw) => {
    const node = asRecord(raw) ?? {};
    const data = asRecord(node.data);
    const config = data ? asRecord(data.config) : null;
    const position = asRecord(node.position);
    return {
      id: node.id,
      type: node.type,
      position: {
        x: position?.x ?? 0,
        y: position?.y ?? 0,
      },
      data: {
        type: data?.type,
        config: {
          actionType: config?.actionType,
          triggerType: config?.triggerType,
        },
      },
    };
  });
}

/**
 * Keep only graph connectivity (id, source, target). Edge handles and any
 * other metadata are dropped.
 */
export function projectEdgesForPublicFeed(edges: unknown): UnknownRecord[] {
  if (!Array.isArray(edges)) {
    return [];
  }
  return edges.map((raw) => {
    const edge = asRecord(raw) ?? {};
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
    };
  });
}
