import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  hashRequest,
  type IdempotencyOutcome,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
} from "@/lib/idempotency";

describe("hashRequest", () => {
  it("is independent of object key order", () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
  });

  it("is independent of nested key order", () => {
    expect(hashRequest({ x: { a: 1, b: 2 }, y: [1, 2] })).toBe(
      hashRequest({ y: [1, 2], x: { b: 2, a: 1 } })
    );
  });

  it("differs when a value changes", () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });

  it("differs when array order changes", () => {
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
  });
});

describe("idempotencyEarlyResponse", () => {
  it("returns null for a proceed outcome", () => {
    const outcome: IdempotencyOutcome = {
      kind: "proceed",
      finalize: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    expect(idempotencyEarlyResponse(outcome)).toBeNull();
  });

  it("maps replay to the stored status and body", () => {
    expect(
      idempotencyEarlyResponse({
        kind: "replay",
        responseStatus: 202,
        responseBody: { executionId: "e1" },
      })
    ).toEqual({ status: 202, body: { executionId: "e1" } });
  });

  it("maps conflict to 409 with the original execution id", () => {
    const early = idempotencyEarlyResponse({
      kind: "conflict",
      originalResourceId: "e1",
    });
    const body = early?.body as { code?: string; originalExecutionId?: string };
    expect(early?.status).toBe(409);
    expect(body.code).toBe("idempotency_conflict");
    expect(body.originalExecutionId).toBe("e1");
  });

  it("maps in_progress to 409", () => {
    const early = idempotencyEarlyResponse({ kind: "in_progress" });
    const body = early?.body as { code?: string };
    expect(early?.status).toBe(409);
    expect(body.code).toBe("idempotency_in_progress");
  });
});

describe("recordIdempotentResponse", () => {
  it("finalizes a 2xx with the body and the extracted execution id", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const outcome: IdempotencyOutcome = { kind: "proceed", finalize, release };
    const res = Response.json(
      { executionId: "exec_1", status: "completed" },
      { status: 202 }
    );

    const returned = await recordIdempotentResponse(outcome, res);

    expect(returned).toBe(res);
    expect(release).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith({
      responseStatus: 202,
      responseBody: { executionId: "exec_1", status: "completed" },
      resourceId: "exec_1",
    });
  });

  it("releases the lock on a non-2xx so the client can retry", async () => {
    const finalize = vi.fn();
    const release = vi.fn().mockResolvedValue(undefined);
    const outcome: IdempotencyOutcome = { kind: "proceed", finalize, release };

    await recordIdempotentResponse(
      outcome,
      Response.json({ error: "Spending cap exceeded" }, { status: 403 })
    );

    expect(finalize).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when there is no reserved record", async () => {
    const res = Response.json({ ok: true });
    expect(await recordIdempotentResponse(null, res)).toBe(res);
  });

  it("falls back to id for the resource id (workflow create)", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const outcome: IdempotencyOutcome = {
      kind: "proceed",
      finalize,
      release: vi.fn(),
    };

    await recordIdempotentResponse(outcome, Response.json({ id: "wf_1" }));

    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "wf_1" })
    );
  });
});
