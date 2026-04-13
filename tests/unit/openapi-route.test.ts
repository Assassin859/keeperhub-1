import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSelect = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { select: mockDbSelect },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    name: "name",
    description: "description",
    listedSlug: "listed_slug",
    inputSchema: "input_schema",
    priceUsdcPerCall: "price_usdc_per_call",
    workflowType: "workflow_type",
    category: "category",
    chain: "chain",
    isListed: "is_listed",
  },
}));

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: (s: string) => s,
}));

describe("GET /api/openapi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.keeperhub.com";
  });

  it("returns valid OpenAPI 3.1.0 structure", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("KeeperHub");
    expect(body.servers[0].url).toBe("https://app.keeperhub.com");
  });

  it("includes x-payment-info for paid read workflows", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-1",
            name: "Paid Workflow",
            description: "A paid workflow",
            listedSlug: "paid-workflow",
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
            },
            priceUsdcPerCall: "0.05",
            workflowType: "read",
            category: "web3",
            chain: "base",
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const path = body.paths["/api/mcp/workflows/paid-workflow/call"];

    expect(path).toBeDefined();
    expect(path.post["x-payment-info"]).toBeDefined();
    expect(path.post["x-payment-info"].price.amount).toBe("0.05");
    expect(path.post.responses["402"]).toBeDefined();
  });

  it("excludes x-payment-info for write workflows", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-2",
            name: "Write Workflow",
            description: "Returns calldata",
            listedSlug: "write-workflow",
            inputSchema: null,
            priceUsdcPerCall: "0.10",
            workflowType: "write",
            category: "web3",
            chain: "base",
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const path = body.paths["/api/mcp/workflows/write-workflow/call"];

    expect(path.post["x-payment-info"]).toBeUndefined();
    expect(path.post["x-workflow-type"]).toBe("write");
    expect(path.post.responses["402"]).toBeUndefined();
  });
});
