import { beforeEach, describe, expect, it, vi } from "vitest";

// Pulls in the same server-only-gated modules as the other route tests in
// this directory (history -> version-diff -> step-registry).
vi.mock("server-only", () => ({}));

const {
  mockGetDualAuthContext,
  mockWorkflowsFindFirst,
  mockExecutionsFindFirst,
  mockExecutionsFindMany,
  mockTopLevelUpdateSet,
  mockRecordAuditEvent,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockWorkflowsFindFirst: vi.fn(),
  mockExecutionsFindFirst: vi.fn(),
  mockExecutionsFindMany: vi.fn(),
  mockTopLevelUpdateSet: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
  authFailureResponse: vi.fn(),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: vi.fn(() => null),
}));

// getWorkflowAccess's own DB reads (org-membership lookup) are orthogonal to
// the pre-check this fix touches, so the collaborator is stubbed directly
// rather than re-driving it through the mocked db below.
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi.fn().mockResolvedValue({
    isCreatorWithCurrentAccess: true,
    isSameOrg: true,
    hasFullAccess: true,
    isDeleted: false,
  }),
}));

vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent: mockRecordAuditEvent,
  buildAuditMetadata: vi.fn(() => ({})),
}));

const txStub = {
  delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  })),
  query: {
    workflowExecutions: { findMany: vi.fn().mockResolvedValue([]) },
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: { findFirst: mockWorkflowsFindFirst },
      workflowExecutions: {
        findFirst: mockExecutionsFindFirst,
        findMany: mockExecutionsFindMany,
      },
    },
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({
      set: vi.fn((data: Record<string, unknown>) => ({
        where: vi.fn(() => mockTopLevelUpdateSet(data)),
      })),
    })),
    transaction: vi.fn(async (cb: (tx: typeof txStub) => Promise<void>) => {
      await cb(txStub);
    }),
  },
}));

import { DELETE as purgeExecutions } from "@/app/api/workflows/[workflowId]/executions/route";
import { DELETE as deleteWorkflow } from "@/app/api/workflows/[workflowId]/route";

/** Every column referenced anywhere in a drizzle SQL predicate tree -- same
 * helper, copied verbatim from
 * tests/unit/workflows-list-soft-delete.test.ts, which uses it to prove a
 * query filters on a given column without a live database. */
function columnsIn(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") {
    return found;
  }
  const candidate = node as { name?: unknown; queryChunks?: unknown };
  if (typeof candidate.name === "string" && "table" in candidate) {
    found.push(candidate.name);
  }
  const chunks = candidate.queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      columnsIn(chunk, found);
    }
  }
  return found;
}

function createDeleteRequest(): Request {
  return new Request("http://localhost:3000/api/workflows/wf-1", {
    method: "DELETE",
  });
}

function createPurgeRequest(): Request {
  return new Request("http://localhost:3000/api/workflows/wf-1/executions", {
    method: "DELETE",
  });
}

const mockParams = Promise.resolve({ workflowId: "wf-1" });

const AUTH_CONTEXT = {
  userId: "user-1",
  organizationId: "org-1",
  authMethod: "session" as const,
  apiKeyId: null,
  scope: "mcp:write",
};

const WORKFLOW_ROW = {
  id: "wf-1",
  userId: "user-1",
  organizationId: "org-1",
  isAnonymous: false,
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDualAuthContext.mockResolvedValue(AUTH_CONTEXT);
  mockWorkflowsFindFirst.mockResolvedValue(WORKFLOW_ROW);
});

describe("DELETE /api/workflows/[workflowId] — soft-deleted execution pre-check", () => {
  it("builds a predicate that references deleted_at, not just workflow_id", async () => {
    mockExecutionsFindFirst.mockResolvedValue(undefined);

    await deleteWorkflow(createDeleteRequest(), { params: mockParams });

    const [{ where }] = mockExecutionsFindFirst.mock.calls[0];
    const columns = columnsIn(where);
    expect(columns).toContain("workflow_id");
    expect(columns).toContain("deleted_at");
  });

  it("returns 409 when a live execution is found", async () => {
    mockExecutionsFindFirst.mockResolvedValue({ id: "exec-1" });

    const response = await deleteWorkflow(createDeleteRequest(), {
      params: mockParams,
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.hasExecutions).toBe(true);
  });

  it("deletes without force when no live execution is found (e.g. all soft-deleted)", async () => {
    mockExecutionsFindFirst.mockResolvedValue(undefined);

    const response = await deleteWorkflow(createDeleteRequest(), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it(
    "mirrors the reported dead end: purging run history via the executions " +
      "route, then deleting the workflow without force, now succeeds",
    async () => {
      // Shared fixture: both routes read/write the same in-memory rows, the
      // way both read/write the same table in production.
      const rows = [{ id: "exec-1", deletedAt: null as Date | null }];

      mockExecutionsFindMany.mockImplementation(async () =>
        rows
          .filter((row) => row.deletedAt === null)
          .map((row) => ({ id: row.id }))
      );
      // The purge route soft-deletes exactly the runs its own findMany just
      // selected -- mirrored here by closing over that same result.
      mockTopLevelUpdateSet.mockImplementation((data: { deletedAt: Date }) => {
        for (const row of rows) {
          row.deletedAt = data.deletedAt;
        }
        return Promise.resolve(undefined);
      });

      const purgeResponse = await purgeExecutions(createPurgeRequest(), {
        params: mockParams,
      });
      expect(purgeResponse.status).toBe(200);
      const purgeBody = await purgeResponse.json();
      expect(purgeBody.deletedCount).toBe(1);
      expect(rows[0].deletedAt).not.toBeNull();

      // The purge left no live execution, so the pre-check's findFirst
      // (real query semantics aside) resolves to nothing.
      mockExecutionsFindFirst.mockResolvedValue(undefined);

      const deleteResponse = await deleteWorkflow(createDeleteRequest(), {
        params: mockParams,
      });

      expect(deleteResponse.status).toBe(200);
      const deleteBody = await deleteResponse.json();
      expect(deleteBody.success).toBe(true);
    }
  );
});
