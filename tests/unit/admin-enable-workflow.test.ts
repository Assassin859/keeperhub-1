import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockAuthenticateAdmin,
  mockFindWorkflow,
  mockFindUser,
  mockUpdate,
  mockSyncSchedule,
} = vi.hoisted(() => ({
  mockAuthenticateAdmin: vi.fn(),
  mockFindWorkflow: vi.fn(),
  mockFindUser: vi.fn(),
  mockUpdate: vi.fn(),
  mockSyncSchedule: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  authenticateAdmin: mockAuthenticateAdmin,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: (...args: unknown[]) => mockFindWorkflow(...args),
      },
      users: {
        findFirst: (...args: unknown[]) => mockFindUser(...args),
      },
    },
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => mockUpdate(...args),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: { id: "workflows.id" },
  users: { id: "users.id" },
}));

vi.mock("@/lib/schedule-service", () => ({
  syncWorkflowSchedule: (...args: unknown[]) => mockSyncSchedule(...args),
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

import { POST } from "@/app/api/admin/test/enable-workflow/route.staging";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/test/enable-workflow", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/test/enable-workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateAdmin.mockReturnValue({ authenticated: true });
    mockUpdate.mockResolvedValue(undefined);
    mockSyncSchedule.mockResolvedValue({ ok: true });
  });

  it("returns 401 when admin auth fails", async () => {
    mockAuthenticateAdmin.mockReturnValue({
      authenticated: false,
      error: "nope",
    });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(401);
    expect(mockFindWorkflow).not.toHaveBeenCalled();
  });

  it("returns 400 when workflowId is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 404 when workflow does not exist", async () => {
    mockFindWorkflow.mockResolvedValue(undefined);
    const res = await POST(makeRequest({ workflowId: "wf_missing" }));
    expect(res.status).toBe(404);
  });

  it("returns 403 when workflow owner is not a k6 test user", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [],
    });
    mockFindUser.mockResolvedValue({ email: "real-user@example.com" });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSyncSchedule).not.toHaveBeenCalled();
  });

  it("returns 403 when owner email is null", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [],
    });
    mockFindUser.mockResolvedValue({ email: null });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(403);
  });

  it("returns 403 when owner has @techops.services email but no k6- prefix", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [],
    });
    mockFindUser.mockResolvedValue({ email: "ops@techops.services" });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(403);
  });

  it("enables and syncs the workflow when owner is a k6 user", async () => {
    mockFindWorkflow.mockResolvedValue({
      id: "wf_1",
      userId: "u_1",
      nodes: [{ id: "t" }],
    });
    mockFindUser.mockResolvedValue({ email: "k6-vu1-12345@techops.services" });
    const res = await POST(makeRequest({ workflowId: "wf_1" }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSyncSchedule).toHaveBeenCalledWith("wf_1", [{ id: "t" }]);
    const json = (await res.json()) as { enabled: boolean };
    expect(json.enabled).toBe(true);
  });
});
