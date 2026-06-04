import deepDiff from "deep-diff";
import { db } from "@/lib/db";
import { securityAuditLog } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getRequestCountry,
  getRequestSourceIp,
} from "@/lib/security/request-attribution";

/**
 * Durable record of a sensitive account/security action: who did it, what
 * changed, and from where. Pairs with the out-of-band email alerts -- the
 * email is the real-time signal, this is the queryable forensic history.
 *
 * Every write is best-effort: a failure here is logged but never thrown, so a
 * transient DB hiccup in the audit path can never break the user action that
 * triggered it. Callers may `await` it (the insert is cheap and these events
 * are infrequent), but a failure will not surface.
 */

export type AuditActor = {
  /** The user who performed the action; null for unauthenticated/system paths. */
  userId: string | null;
  /** Org context for the action, if any. */
  organizationId: string | null;
  /** How the request authenticated: session | api-key | oauth | internal | unknown. */
  authMethod: string;
  /** The API key id when the action was performed via an API key. */
  apiKeyId?: string | null;
};

export type RecordAuditEventArgs = {
  actor: AuditActor;
  /** Dotted action name, e.g. "api_key.created", "api_key.revoked". */
  action: string;
  /** The kind of resource acted on, e.g. "api_key", "user", "workflow". */
  resourceType?: string | null;
  resourceId?: string | null;
  /** Prior state for a mutation; omit for pure create events. */
  before?: unknown;
  /** New state for a mutation; omit for pure delete events. */
  after?: unknown;
  /** Request context (ip, userAgent) and any action-specific details. */
  metadata?: Record<string, unknown> | null;
};

/**
 * Build the structured diff stored in the `diff` column. Returns null when
 * there is nothing to diff (create/delete events, or identical states) so the
 * column stays meaningfully empty rather than holding `undefined`.
 */
function buildDiff(before: unknown, after: unknown): unknown {
  if (before === undefined && after === undefined) {
    return null;
  }
  const changes = deepDiff.diff(before, after);
  return changes ?? null;
}

/**
 * Build the standard request-context metadata (ip, country, user agent) for an
 * audit event so the "from where" question is answerable. Individual fields
 * are null when the proxy did not supply them.
 */
export function buildAuditMetadata(request: Request): Record<string, unknown> {
  return {
    ip: getRequestSourceIp(request),
    country: getRequestCountry(request),
    userAgent: request.headers.get("user-agent"),
  };
}

export async function recordAuditEvent(
  args: RecordAuditEventArgs
): Promise<void> {
  const { actor, action, resourceType, resourceId, before, after, metadata } =
    args;
  try {
    await db.insert(securityAuditLog).values({
      actorUserId: actor.userId,
      organizationId: actor.organizationId,
      authMethod: actor.authMethod,
      apiKeyId: actor.apiKeyId ?? null,
      action,
      resourceType: resourceType ?? null,
      resourceId: resourceId ?? null,
      diff: buildDiff(before, after),
      metadata: metadata ?? null,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to record security audit event",
      error,
      { action }
    );
  }
}
