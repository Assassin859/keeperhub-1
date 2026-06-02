import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(),
}));

vi.mock("@/lib/mcp/listing", () => ({
  listWorkflow: vi.fn(),
  unlistWorkflow: vi.fn(),
  updateWorkflowListing: vi.fn(),
}));

import { listWorkflow, unlistWorkflow } from "@/lib/mcp/listing";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

// Dynamic import after mocks are set up
const { POST, DELETE } = await import(
  "@/app/api/mcp/workflows/[slug]/listing/route"
);

const makePostRequest = (body?: unknown) =>
  new Request("http://localhost/api/mcp/workflows/wf-123/listing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const makeDeleteRequest = () =>
  new Request("http://localhost/api/mcp/workflows/wf-123/listing", {
    method: "DELETE",
  });

const makeParams = (id = "wf-123") => ({
  params: Promise.resolve({ slug: id }),
});

const mockAuth = (orgId = "org-abc") =>
  vi.mocked(getDualAuthContext).mockResolvedValue({
    userId: "user-1",
    organizationId: orgId,
    authMethod: "session" as const,
    apiKeyId: null,
  });

const mockNoAuth = () =>
  vi.mocked(getDualAuthContext).mockResolvedValue({
    error: "Unauthorized",
    status: 401,
  });

describe("mcp curator tools — org-scope and auth enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("org-scope 404: POST returns 404 when listing helper returns NOT_FOUND", async () => {
    mockAuth();
    vi.mocked(listWorkflow).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });

    const res = await POST(
      makePostRequest({ slug: "my-workflow" }),
      makeParams()
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Workflow not found");
  });

  it("org-scope 404: DELETE returns 404 when unlist helper returns NOT_FOUND", async () => {
    mockAuth();
    vi.mocked(unlistWorkflow).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });

    const res = await DELETE(makeDeleteRequest(), makeParams());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Workflow not found");
  });

  it("unauthenticated POST returns 401", async () => {
    mockNoAuth();

    const res = await POST(
      makePostRequest({ slug: "my-workflow" }),
      makeParams()
    );
    expect(res.status).toBe(401);
  });
});
