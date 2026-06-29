import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// requireOrganization is a pass-through HOC here: it just invokes the handler
// with a fixed org context so we exercise the route's own param parsing.
vi.mock("@/lib/middleware/require-org", () => ({
  requireOrganization:
    (handler: (req: NextRequest, context: unknown) => Promise<Response>) =>
    (req: NextRequest) =>
      handler(req, { organization: { id: "org_1" } }),
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
