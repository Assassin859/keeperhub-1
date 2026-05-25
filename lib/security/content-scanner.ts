/**
 * Pre-execution content-pattern scanner. Walks every node's config JSON for
 * suspicious patterns and emits a single Sentry event per workflow run
 * summarising any hits. Alert-only in v0; the env flag
 * `CONTENT_SCANNER_ENFORCE` is reserved for a follow-up that converts
 * matches into hard blocks once baseline noise is understood.
 *
 * The pattern names are the alert grouping key. The actual matched value
 * never leaves this module: alerts must be readable without exposing the
 * credentials they detect. Add patterns by appending to `PATTERNS` and
 * extending `tests/unit/content-scanner.test.ts`.
 *
 * KEEP-612: bullet "Content-pattern alerts on workflow node config and
 * execution payloads: 169.254.169.254, information_schema, pg_catalog,
 * neon_auth, refresh_token, client_secret, DATABASE_URL".
 */

import { captureMessage } from "@sentry/nextjs";

type Pattern = {
  readonly name: string;
  readonly regex: RegExp;
};

const PATTERNS: readonly Pattern[] = [
  { name: "imds_metadata_ip", regex: /169\.254\.169\.254/ },
  { name: "pg_information_schema", regex: /\binformation_schema\b/i },
  { name: "pg_catalog", regex: /\bpg_catalog\b/i },
  { name: "neon_auth", regex: /\bneon_auth\b/i },
  { name: "refresh_token", regex: /\brefresh_token\b/i },
  { name: "client_secret", regex: /\bclient_secret\b/i },
  { name: "database_url", regex: /\bDATABASE_URL\b/ },
];

export type ContentScanHit = {
  pattern: string;
  nodeId: string;
  nodeType: string;
  jsonPath: string;
};

export type WorkflowNodeLike = {
  id: string;
  data?: {
    type?: string;
    config?: unknown;
  };
};

export type ScanContext = {
  workflowId?: string;
  executionId?: string;
  organizationId?: string;
};

export function scanNodes(
  nodes: readonly WorkflowNodeLike[]
): ContentScanHit[] {
  const hits: ContentScanHit[] = [];
  for (const node of nodes) {
    const config = node.data?.config;
    if (config === undefined || config === null) {
      continue;
    }
    scanValue(config, `${node.id}.config`, node, hits);
  }
  return hits;
}

function scanValue(
  value: unknown,
  path: string,
  node: WorkflowNodeLike,
  hits: ContentScanHit[]
): void {
  if (typeof value === "string") {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(value)) {
        hits.push({
          pattern: pattern.name,
          nodeId: node.id,
          nodeType: node.data?.type ?? "unknown",
          jsonPath: path,
        });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      scanValue(item, `${path}[${index}]`, node, hits);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      scanValue(child, `${path}.${key}`, node, hits);
    }
  }
}

/**
 * Dedupe by (nodeId, pattern) so a config with the same pattern in 100
 * places contributes one tuple to the report rather than 100. Different
 * jsonPaths under the same (node, pattern) collapse to the first
 * occurrence, which is what triagers care about.
 */
function dedupeHits(hits: readonly ContentScanHit[]): ContentScanHit[] {
  const seen = new Set<string>();
  const unique: ContentScanHit[] = [];
  for (const hit of hits) {
    const key = `${hit.nodeId}:${hit.pattern}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

export function emitScanReport(
  hits: readonly ContentScanHit[],
  context: ScanContext
): void {
  if (hits.length === 0) {
    return;
  }
  const unique = dedupeHits(hits);
  try {
    captureMessage("security.content_scanner_hit", {
      level: "warning",
      tags: { security: "content_scanner_hit" },
      extra: {
        workflowId: context.workflowId,
        executionId: context.executionId,
        organizationId: context.organizationId,
        hitCount: unique.length,
        hits: unique,
      },
    });
  } catch {
    // Best-effort. Sentry transport failure must never escape into the
    // executor or change workflow execution semantics.
  }
  // Structured stdout line for Loki / log-only alerting. Independent of
  // Sentry transport so the signal lands even with SENTRY_DSN unset.
  try {
    console.warn(
      JSON.stringify({
        event: "security.content_scanner_hit",
        workflowId: context.workflowId,
        executionId: context.executionId,
        organizationId: context.organizationId,
        hitCount: unique.length,
        hits: unique,
      })
    );
  } catch {
    // never let log emission escape into the executor
  }
}

/**
 * Convenience entry point: scan + report in one call. Use this from the
 * executor unless you need the raw hit list (tests do).
 */
export function scanAndReport(
  nodes: readonly WorkflowNodeLike[],
  context: ScanContext
): void {
  const hits = scanNodes(nodes);
  emitScanReport(hits, context);
}
