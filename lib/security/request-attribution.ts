/**
 * Attribution helpers for security/audit columns on workflow_executions.
 *
 * The values produced here are written to non-FK audit columns and consumed
 * by KEEP-612 detection alerts (throughput spike per key, org-API-key use
 * off-hours, ASN anomaly). They are never load-bearing for authorization.
 *
 * IP resolution policy: Cloudflare's `cf-connecting-ip` is the canonical
 * client IP because our prod ingress terminates at CF and CF strips any
 * client-supplied value. If the header is absent (local dev, internal
 * services that bypass the edge), we fall through to the trusted-proxy XFF
 * resolver from `./trusted-proxies` and return `null` when neither source
 * is trustworthy. Audit columns stay NULL rather than recording a misleading
 * sentinel.
 */

import { resolveTrustedClientIp } from "./trusted-proxies";

/**
 * `trigger_source` label written to `workflow_executions.trigger_source`.
 *
 * Relationship to `TriggerType` (lib/metrics/types.ts): this union is a
 * strict superset. TriggerType is the Prometheus-label vocabulary for the
 * `keeperhub_workflow_executions_started_total` metric and contains
 * (manual | webhook | scheduled | schedule | block | event). TriggerSource
 * adds `mcp` and `internal` to distinguish auth paths the metric label set
 * intentionally conflates -- a workflow with a manual trigger node can be
 * invoked via the MCP marketplace path OR a direct API call, and the
 * security attribution column wants to tell them apart even though both
 * report `manual` to Prometheus.
 *
 * If a new value is added here that doesn't also belong in TriggerType,
 * the `triggerType as TriggerSource` cast in
 * `app/api/workflow/[workflowId]/execute/route.ts` will be unsound. Keep
 * the cast direction (TriggerType -> TriggerSource) and add new values
 * to whichever union actually needs them; do not invert.
 */
export type TriggerSource =
  | "manual"
  | "webhook"
  | "scheduled"
  | "schedule"
  | "mcp"
  | "internal"
  | "block"
  | "event";

export function getRequestSourceIp(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) {
    return cf;
  }

  const peer = request.headers.get("x-real-ip")?.trim();
  if (!peer) {
    return null;
  }
  const resolved = resolveTrustedClientIp(request, peer);
  return resolved === "unknown" ? null : resolved;
}

/**
 * Cloudflare emits a two-letter ISO country code via `cf-ipcountry` on every
 * request it proxies. Cheaper than MaxMind enrichment and good enough as a
 * v0 dimension for "org-API-key use from a new country" behavioural alerts.
 * Returns null for direct-to-origin traffic or non-CF deployments.
 */
export function getRequestCountry(request: Request): string | null {
  const raw = request.headers.get("cf-ipcountry")?.trim();
  if (!raw) {
    return null;
  }
  // CF uses "XX" for unknown / Tor / anonymizing proxies. Treat as null so
  // alert grouping doesn't pollute the legitimate-country buckets.
  if (raw === "XX" || raw === "T1") {
    return null;
  }
  return raw;
}

export type ExecutionAttribution = {
  triggeredByUserApiKeyId: string | null;
  triggeredByOrgApiKeyId: string | null;
  triggeredByIp: string | null;
  triggeredByCountry: string | null;
  triggerSource: TriggerSource;
};

export function buildAttribution(input: {
  request?: Request;
  source: TriggerSource;
  userApiKeyId?: string | null;
  orgApiKeyId?: string | null;
}): ExecutionAttribution {
  return {
    triggeredByUserApiKeyId: input.userApiKeyId ?? null,
    triggeredByOrgApiKeyId: input.orgApiKeyId ?? null,
    triggeredByIp: input.request ? getRequestSourceIp(input.request) : null,
    triggeredByCountry: input.request ? getRequestCountry(input.request) : null,
    triggerSource: input.source,
  };
}
