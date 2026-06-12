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

/**
 * The exact node shape the anonymous feed emits. Deliberately narrow: `config`
 * holds only the two render hints, so a consumer that reaches for node config
 * (e.g. `node.data.config.contractAddress`) is a compile error rather than a
 * silent `undefined`, and the route cannot accidentally serialize full nodes.
 */
export type PublicFeedNode = {
  id: string | undefined;
  type: string | undefined;
  position: { x: number; y: number };
  data: {
    type: string | undefined;
    config: {
      actionType: string | undefined;
      triggerType: string | undefined;
    };
  };
};

/** The exact edge shape the anonymous feed emits: connectivity only. */
export type PublicFeedEdge = {
  id: string | undefined;
  source: string | undefined;
  target: string | undefined;
};

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Read a node-config field, preferring `data.config.<field>` but falling back
 * to the legacy top-level `data.<field>`. The rest of the codebase
 * (lib/mcp/calldata.ts, lib/mcp/listing-validators.ts) accepts both shapes for
 * actionType, and legacy / in-flight workflows still carry the top-level form;
 * the feed must read the same way or those nodes project a blank type and the
 * marketplace icon falls back to a generic box.
 */
function readNodeConfigField(
  data: UnknownRecord | null,
  config: UnknownRecord | null,
  field: string
): unknown {
  const fromConfig = config?.[field];
  return fromConfig === undefined ? data?.[field] : fromConfig;
}

/**
 * Normalize colon-separated action types (`code:run-code`) to the slash form
 * (`code/run-code`). sanitize-nodes does this on the write path, but legacy /
 * in-flight nodes may still carry the colon form, and the icon lookup
 * (WorkflowNodeIcons) splits on "/" to resolve the brand.
 */
function normalizeActionType(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(":", "/") : undefined;
}

/**
 * Keep only the node fields the feed renders: id, type, position, and the
 * node/action/trigger type used to pick an icon. All other config is dropped.
 */
export function projectNodesForPublicFeed(nodes: unknown): PublicFeedNode[] {
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes.map((raw): PublicFeedNode => {
    const node = asRecord(raw) ?? {};
    const data = asRecord(node.data);
    const config = data ? asRecord(data.config) : null;
    const position = asRecord(node.position);
    return {
      id: asString(node.id),
      type: asString(node.type),
      position: {
        x: asNumber(position?.x),
        y: asNumber(position?.y),
      },
      data: {
        type: asString(data?.type),
        config: {
          actionType: normalizeActionType(
            readNodeConfigField(data, config, "actionType")
          ),
          triggerType: asString(
            readNodeConfigField(data, config, "triggerType")
          ),
        },
      },
    };
  });
}

/**
 * Keep only graph connectivity (id, source, target). Edge handles and any
 * other metadata are dropped.
 */
export function projectEdgesForPublicFeed(edges: unknown): PublicFeedEdge[] {
  if (!Array.isArray(edges)) {
    return [];
  }
  return edges.map((raw): PublicFeedEdge => {
    const edge = asRecord(raw) ?? {};
    return {
      id: asString(edge.id),
      source: asString(edge.source),
      target: asString(edge.target),
    };
  });
}
