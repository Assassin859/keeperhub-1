import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks -- available to vi.mock factories which run before any imports
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  checkRateLimit: vi.fn(),
  enforceExecutionLimit: vi.fn(),
  enterApiExecuteErrorContext: vi.fn(),
  checkAndReserveExecution: vi.fn(),
  requireWallet: vi.fn(),
  createExecution: vi.fn(),
  markRunning: vi.fn(),
  completeExecution: vi.fn(),
  failExecution: vi.fn(),
  setRetryCount: vi.fn(),
  redactInput: vi.fn(),
  resolveAction: vi.fn(),
  stepFn: vi.fn(),
  ownershipResult: [] as unknown[],
  capturedInput: undefined as Record<string, unknown> | undefined,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/app/api/execute/_lib/auth", () => ({
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: mocks.enforceExecutionLimit,
}));

vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: mocks.enterApiExecuteErrorContext,
}));

vi.mock("@/app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: mocks.checkAndReserveExecution,
}));

vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: mocks.requireWallet,
}));

vi.mock("@/app/api/execute/_lib/execution-service", () => ({
  createExecution: mocks.createExecution,
  markRunning: mocks.markRunning,
  completeExecution: mocks.completeExecution,
  failExecution: mocks.failExecution,
  setRetryCount: mocks.setRetryCount,
  redactInput: mocks.redactInput,
}));

vi.mock("@/app/api/execute/_lib/action-resolver", () => ({
  resolveAction: mocks.resolveAction,
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("@/lib/db/schema", () => ({
  integrations: { id: "id", organizationId: "organizationId" },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(mocks.ownershipResult)),
        })),
      })),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Route import (after mocks are registered)
// ---------------------------------------------------------------------------

import { POST as nodePOST } from "@/app/api/execute/node/route";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const AUTH_CONTEXT = { organizationId: "org_a", apiKeyId: "kh_1" };
const AUTH_HEADER = { Authorization: "Bearer kh_test123" };

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/execute/node", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ownershipResult = [];
  mocks.capturedInput = undefined;

  mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
  mocks.checkRateLimit.mockReturnValue({ allowed: true });
  mocks.enforceExecutionLimit.mockResolvedValue({ blocked: false });
  mocks.enterApiExecuteErrorContext.mockResolvedValue(undefined);
  mocks.requireWallet.mockResolvedValue(null);
  mocks.checkAndReserveExecution.mockResolvedValue({
    allowed: true,
    executionId: "ex1",
  });
  mocks.createExecution.mockResolvedValue({ executionId: "ex1" });
  mocks.markRunning.mockResolvedValue(undefined);
  mocks.completeExecution.mockResolvedValue(undefined);
  mocks.failExecution.mockResolvedValue(undefined);
  mocks.setRetryCount.mockResolvedValue(undefined);
  mocks.redactInput.mockImplementation(
    (input: Record<string, unknown>) => input
  );

  mocks.stepFn.mockImplementation((input: Record<string, unknown>) => {
    mocks.capturedInput = input;
    return Promise.resolve({ success: true });
  });

  mocks.resolveAction.mockImplementation((actionType: string) => ({
    actionType,
    label: "Test Action",
    importer: {
      importer: () => Promise.resolve({ step: mocks.stepFn }),
      stepFunction: "step",
    },
    isPluginAction: true,
  }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/execute/node reserved-field gating", () => {
  it("rejects a foreign integrationId smuggled inside config with 403", async () => {
    mocks.ownershipResult = [];

    const response = await nodePOST(
      postRequest({
        actionType: "discord/send-message",
        config: { integrationId: "int_foreign", message: "hi" },
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.checkAndReserveExecution).not.toHaveBeenCalled();
    expect(mocks.stepFn).not.toHaveBeenCalled();
  });

  it("gates a network smuggled inside config through wallet + spending cap", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", contractAddress: "0xabc" },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.requireWallet).toHaveBeenCalledTimes(1);
    expect(mocks.checkAndReserveExecution).toHaveBeenCalledTimes(1);
    expect(mocks.checkAndReserveExecution).toHaveBeenCalledWith(
      expect.objectContaining({ network: "1" })
    );
    expect(mocks.capturedInput?.network).toBe("1");
    expect(
      (mocks.capturedInput?._context as { organizationId: string })
        .organizationId
    ).toBe("org_a");
  });

  it("ignores a caller-supplied _context and always sets the trusted org", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: { network: "1", _context: { organizationId: "evil" } },
      })
    );

    expect(response.status).toBe(200);
    expect(
      (mocks.capturedInput?._context as { organizationId: string })
        .organizationId
    ).toBe("org_a");
  });

  it("strips a caller-supplied web3Connection so it cannot weaken the signer mode", async () => {
    const response = await nodePOST(
      postRequest({
        actionType: "web3/write-contract",
        config: {
          network: "1",
          contractAddress: "0xabc",
          // Attempt to force the org Turnkey EOA and bypass the Safe's
          // Zodiac Roles policy on an org-custodied write.
          web3Connection: "eoa",
        },
      })
    );

    expect(response.status).toBe(200);
    // The step must never see web3Connection: with it absent,
    // resolveSignerForNode falls back to the org-policy (Safe + Role) path.
    expect(mocks.capturedInput).toBeDefined();
    expect("web3Connection" in (mocks.capturedInput ?? {})).toBe(false);
  });

  it("passes an owned top-level integrationId through to the step", async () => {
    mocks.ownershipResult = [{ id: "int_mine" }];

    const response = await nodePOST(
      postRequest({
        actionType: "discord/send-message",
        integrationId: "int_mine",
        config: { message: "hi" },
      })
    );

    expect([200, 202]).toContain(response.status);
    expect(mocks.capturedInput?.integrationId).toBe("int_mine");
  });
});
