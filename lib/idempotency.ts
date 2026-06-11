import "server-only";

import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyRecords } from "@/lib/db/schema-extensions";
import { generateId } from "@/lib/utils/id";

// A reserved record holds a short "lock" so a crashed request can't block a
// retry for long; once the work finishes the record is extended to the full
// replay window.
const PROCESSING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RACE_RETRIES = 3;

export type IdempotencyFinalizeArgs = {
  responseStatus: number;
  responseBody: unknown;
  resourceId?: string | null;
};

export type IdempotencyOutcome =
  | {
      kind: "proceed";
      finalize: (args: IdempotencyFinalizeArgs) => Promise<void>;
      release: () => Promise<void>;
    }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "conflict"; originalResourceId: string | null }
  | { kind: "in_progress" };

// Deterministic JSON so two logically-equal request bodies hash identically
// regardless of key order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

// Exported for tests: two logically-equal bodies must hash identically so a
// retry isn't mistaken for a conflicting request.
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

function buildProceed(recordId: string): IdempotencyOutcome {
  return {
    kind: "proceed",
    finalize: async ({ responseStatus, responseBody, resourceId }) => {
      await db
        .update(idempotencyRecords)
        .set({
          status: "completed",
          responseStatus,
          // biome-ignore lint/suspicious/noExplicitAny: jsonb column stores arbitrary response bodies
          responseBody: responseBody as any,
          resourceId: resourceId ?? null,
          expiresAt: new Date(Date.now() + COMPLETED_TTL_MS),
        })
        .where(eq(idempotencyRecords.id, recordId));
    },
    release: async () => {
      await db
        .delete(idempotencyRecords)
        .where(eq(idempotencyRecords.id, recordId));
    },
  };
}

export type BeginIdempotentArgs = {
  organizationId: string;
  scope: string;
  key: string;
  requestBody: unknown;
};

export async function beginIdempotent(
  args: BeginIdempotentArgs,
  attempt = 0
): Promise<IdempotencyOutcome> {
  const requestHash = hashRequest(args.requestBody);
  const now = Date.now();
  const id = generateId();

  // Reserve the slot atomically: the unique (organization, scope, key) index
  // makes concurrent duplicates serialize on insert.
  const inserted = await db
    .insert(idempotencyRecords)
    .values({
      id,
      organizationId: args.organizationId,
      scope: args.scope,
      idempotencyKey: args.key,
      requestHash,
      status: "processing",
      expiresAt: new Date(now + PROCESSING_TTL_MS),
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyRecords.id });

  if (inserted.length > 0) {
    return buildProceed(id);
  }

  const [existing] = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.organizationId, args.organizationId),
        eq(idempotencyRecords.scope, args.scope),
        eq(idempotencyRecords.idempotencyKey, args.key)
      )
    )
    .limit(1);

  // Lost a race with a concurrent delete (release or expiry sweep). Retry.
  if (!existing) {
    if (attempt >= MAX_RACE_RETRIES) {
      return { kind: "in_progress" };
    }
    return beginIdempotent(args, attempt + 1);
  }

  // A stale processing lock (crashed request) or an expired completed record:
  // reclaim the slot for this fresh request, guarding against a concurrent
  // reclaim with a conditional update on expires_at.
  if (existing.expiresAt.getTime() <= now) {
    const reclaimed = await db
      .update(idempotencyRecords)
      .set({
        requestHash,
        status: "processing",
        responseStatus: null,
        responseBody: null,
        resourceId: null,
        createdAt: new Date(now),
        expiresAt: new Date(now + PROCESSING_TTL_MS),
      })
      .where(
        and(
          eq(idempotencyRecords.id, existing.id),
          lt(idempotencyRecords.expiresAt, new Date(now))
        )
      )
      .returning({ id: idempotencyRecords.id });
    if (reclaimed.length > 0) {
      return buildProceed(existing.id);
    }
    if (attempt >= MAX_RACE_RETRIES) {
      return { kind: "in_progress" };
    }
    return beginIdempotent(args, attempt + 1);
  }

  if (existing.requestHash !== requestHash) {
    return { kind: "conflict", originalResourceId: existing.resourceId };
  }

  if (existing.status === "completed") {
    return {
      kind: "replay",
      responseStatus: existing.responseStatus ?? 200,
      responseBody: existing.responseBody,
    };
  }

  return { kind: "in_progress" };
}

function pickString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Records the work's response against a reserved idempotency record. A 2xx is
// stored for replay (keyed to its resource id); any other status releases the
// lock so the client can fix the request and retry with the same key. Reads the
// response via clone() so the original is still returned untouched. No-op when
// there is no reserved record (no key, or a replay/conflict outcome).
export async function recordIdempotentResponse<T extends Response>(
  outcome: IdempotencyOutcome | null,
  response: T
): Promise<T> {
  if (outcome?.kind !== "proceed") {
    return response;
  }
  if (response.status >= 200 && response.status < 300) {
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      body = null;
    }
    const record = (body ?? {}) as Record<string, unknown>;
    const resourceId =
      pickString(record.executionId) ??
      pickString(record.id) ??
      pickString(record.workflowId);
    await outcome.finalize({
      responseStatus: response.status,
      responseBody: body,
      resourceId,
    });
  } else {
    await outcome.release();
  }
  return response;
}

// Convenience: reads the `Idempotency-Key` header and reserves a slot, or
// returns null when the client did not opt in to idempotency.
export async function beginIdempotentFromRequest(args: {
  request: Request;
  organizationId: string;
  scope: string;
  requestBody: unknown;
}): Promise<IdempotencyOutcome | null> {
  const key = args.request.headers.get("Idempotency-Key")?.trim();
  if (!key) {
    return null;
  }
  return await beginIdempotent({
    organizationId: args.organizationId,
    scope: args.scope,
    key,
    requestBody: args.requestBody,
  });
}

export type IdempotencyEarlyResponse = { status: number; body: unknown };

// Maps a non-proceed outcome to the response the caller should return as-is.
// Returns null for `proceed` (the caller does the work, then calls finalize).
export function idempotencyEarlyResponse(
  outcome: IdempotencyOutcome
): IdempotencyEarlyResponse | null {
  switch (outcome.kind) {
    case "replay":
      return { status: outcome.responseStatus, body: outcome.responseBody };
    case "conflict":
      return {
        status: 409,
        body: {
          error:
            "Idempotency-Key was reused with a different request payload. Use a new key for a different request.",
          code: "idempotency_conflict",
          originalExecutionId: outcome.originalResourceId,
        },
      };
    case "in_progress":
      return {
        status: 409,
        body: {
          error:
            "A request with this Idempotency-Key is already being processed. Retry shortly.",
          code: "idempotency_in_progress",
        },
      };
    default:
      return null;
  }
}
