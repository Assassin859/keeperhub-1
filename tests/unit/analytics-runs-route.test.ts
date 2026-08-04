import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const resolveOrganizationIdMock = vi.fn();

vi.mock("@/lib/middleware/auth-helpers", () => ({
  resolveOrganizationId: (...args: unknown[]) =>
    resolveOrganizationIdMock(...args),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: (grantedScope: string | undefined, required: string) => {
    if (grantedScope === "mcp:read" || grantedScope === undefined) {
      return null;
    }
    return new Response(
      JSON.stringify({ error: "insufficient_scope", required_scope: required }),
      { status: 403 }
    );
  },
}));

vi.mock("@/lib/analytics/queries", () => ({
  getUnifiedRuns: vi.fn().mockResolvedValue({
    runs: [],
    nextCursor: null,
    total: 0,
    page: 1,
    pageSize: 50,
  }),
}));

import { GET } from "@/app/api/analytics/runs/route";
import { getUnifiedRuns } from "@/lib/analytics/queries";

function requestForStatus(status: string): NextRequest {
  return {
    nextUrl: {
      searchParams: new URLSearchParams({ status }),
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveOrganizationIdMock.mockResolvedValue({
    organizationId: "org_1",
    scope: "mcp:read",
    authMethod: "oauth",
    apiKeyId: null,
  });
});

describe("GET /api/analytics/runs status filter", () => {
  it("forwards system_error so the dedicated filter isolates platform failures", async () => {
    await GET(requestForStatus("system_error"));

    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_1",
      expect.anything(),
      expect.objectContaining({ status: "system_error" })
    );
  });

  it("forwards external_error so the dedicated filter isolates dependency failures", async () => {
    await GET(requestForStatus("external_error"));

    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_1",
      expect.anything(),
      expect.objectContaining({ status: "external_error" })
    );
  });

  it("forwards the other known statuses unchanged", async () => {
    for (const status of [
      "pending",
      "running",
      "success",
      "error",
      "cancelled",
    ]) {
      await GET(requestForStatus(status));
      expect(getUnifiedRuns).toHaveBeenLastCalledWith(
        "org_1",
        expect.anything(),
        expect.objectContaining({ status })
      );
    }
  });

  it("drops an unknown status to undefined", async () => {
    await GET(requestForStatus("bogus"));

    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_1",
      expect.anything(),
      expect.objectContaining({ status: undefined })
    );
  });
});

describe("GET /api/analytics/runs auth", () => {
  it("returns 401 when OAuth token cannot resolve org", async () => {
    resolveOrganizationIdMock.mockResolvedValueOnce({
      error: "Unauthorized",
      status: 401,
    });

    const res = await GET(requestForStatus("success"));
    expect(res.status).toBe(401);
    expect(getUnifiedRuns).not.toHaveBeenCalled();
  });

  it("accepts mcp:read OAuth scope", async () => {
    const res = await GET(requestForStatus("success"));
    expect(res.status).toBe(200);
  });
});
