/**
 * Phase 37 fix #2: workflow-slug binding for /sign.
 *
 * verifyWorkflowBinding(slug, payTo, amountMicro) reads the workflows
 * registry and the active organization wallet, then verifies that the
 * caller-supplied payTo + amount match the registry-derived expected
 * values. This is the server-side gate that closes the HMAC-compromise
 * drain — without it, a stolen HMAC secret could redirect a wallet's
 * funds to any address the attacker chose.
 *
 * Strategy: hoisted vi mocks for db.select() so the test stays focused
 * on the matching logic and does not require a live Postgres. The mock
 * routes the first .from() call to the workflows fixture and the second
 * to the organizationWallets fixture by tracking call order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkflowRow = {
  id: string;
  organizationId: string | null;
  priceUsdcPerCall: string | null;
  isListed: boolean;
  chain: string | null;
};

type WalletRow = {
  walletAddress: string;
};

const { mockSelectQueue } = vi.hoisted(
  (): { mockSelectQueue: { rows: unknown[][] } } => ({
    mockSelectQueue: { rows: [] },
  })
);

vi.mock("@/lib/db", () => ({
  db: {
    select: (): {
      from: () => {
        where: () => {
          limit: () => Promise<unknown[]>;
        };
      };
    } => ({
      from: () => ({
        where: () => ({
          limit: (): Promise<unknown[]> => {
            const next = mockSelectQueue.rows.shift() ?? [];
            return Promise.resolve(next);
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: { _table: "workflows" },
  organizationWallets: { _table: "para_wallets" },
}));

const { verifyWorkflowBinding } = await import(
  "@/lib/agentic-wallet/workflow-binding"
);

const SLUG = "test-slug";
const CREATOR = "0xCreATor000000000000000000000000000000001";
const ATTACKER = "0xAttacker0000000000000000000000000000beef";

function queueWorkflow(row: Partial<WorkflowRow> | null): void {
  if (row === null) {
    mockSelectQueue.rows.push([]);
    return;
  }
  const full: WorkflowRow = {
    id: "wf_test",
    organizationId: "org_test",
    priceUsdcPerCall: "0.05",
    isListed: true,
    chain: null,
    ...row,
  };
  mockSelectQueue.rows.push([full]);
}

function queueWallet(row: Partial<WalletRow> | null): void {
  if (row === null) {
    mockSelectQueue.rows.push([]);
    return;
  }
  const full: WalletRow = { walletAddress: CREATOR, ...row };
  mockSelectQueue.rows.push([full]);
}

describe("verifyWorkflowBinding", () => {
  beforeEach(() => {
    mockSelectQueue.rows = [];
  });

  it("returns ok when slug + payTo + amount all match", async () => {
    queueWorkflow({});
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expectedPayTo).toBe(CREATOR);
      expect(r.expectedAmountMicro).toBe("50000");
      expect(r.workflowId).toBe("wf_test");
    }
  });

  it("returns 403 PAYTO_MISMATCH when payTo differs from registry", async () => {
    queueWorkflow({});
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "base", ATTACKER, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "PAYTO_MISMATCH",
    });
  });

  it("returns 403 AMOUNT_MISMATCH when amount differs from priceUsdcPerCall", async () => {
    queueWorkflow({});
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "100000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "AMOUNT_MISMATCH",
    });
  });

  it("returns 403 UNKNOWN_WORKFLOW for an unknown slug", async () => {
    queueWorkflow(null);
    const r = await verifyWorkflowBinding("nope", "base", CREATOR, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "UNKNOWN_WORKFLOW",
    });
  });

  it("returns 403 WORKFLOW_NOT_PAYABLE when workflow has no active org wallet", async () => {
    queueWorkflow({});
    queueWallet(null);
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "WORKFLOW_NOT_PAYABLE",
    });
  });

  it("compares addresses case-insensitively", async () => {
    queueWorkflow({});
    queueWallet({ walletAddress: CREATOR.toUpperCase() });
    const r = await verifyWorkflowBinding(
      SLUG,
      "base",
      CREATOR.toLowerCase(),
      "50000"
    );
    expect(r.ok).toBe(true);
  });

  it("returns 400 WORKFLOW_SLUG_REQUIRED when slug is empty", async () => {
    const r = await verifyWorkflowBinding("", "base", CREATOR, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      code: "WORKFLOW_SLUG_REQUIRED",
    });
  });

  it("returns 403 UNKNOWN_WORKFLOW when slug exists but isListed=false", async () => {
    // The SQL `where` filters on isListed=true at the DB level, so an
    // unlisted row never reaches the code. Simulate by queueing an empty
    // result for the workflow lookup.
    queueWorkflow(null);
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "UNKNOWN_WORKFLOW",
    });
  });

  // Fix-pack-2 R2: tempo MPP proofs don't carry payTo/amount in their
  // typed-data (only chainId + challengeId). The binding lookup still runs to
  // resolve the workflow's price for the R1 daily-spend deduction, but the
  // caller-side payTo/amount equality checks MUST be skipped — otherwise
  // every priced tempo workflow 403s on PAYTO_MISMATCH.
  it("tempo: returns ok with empty payTo + amount (skips equality checks)", async () => {
    queueWorkflow({});
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expectedAmountMicro).toBe("50000");
      expect(r.expectedPayTo).toBe(CREATOR);
    }
  });

  it("tempo: still returns UNKNOWN_WORKFLOW for an unknown slug", async () => {
    queueWorkflow(null);
    const r = await verifyWorkflowBinding("nope", "tempo", "", "0");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "UNKNOWN_WORKFLOW",
    });
  });

  // Fix-pack-3 N-1: the caller-supplied chain must match the workflow's
  // registered chain. Without this, an attacker with a compromised HMAC
  // secret could claim chain="tempo" on a Base-registered workflow to bypass
  // the Base-side payTo/amount equality checks and mint an MPP proof
  // against a dual-chain victim's tempo wallet.
  it("returns 403 CHAIN_MISMATCH when caller chain differs from workflow chain", async () => {
    queueWorkflow({ chain: "base" });
    const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "CHAIN_MISMATCH",
    });
  });

  it("accepts a request when caller chain matches the workflow chain", async () => {
    queueWorkflow({ chain: "tempo" });
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
    expect(r.ok).toBe(true);
  });

  it("is permissive when workflow.chain is null (legacy listings)", async () => {
    queueWorkflow({ chain: null });
    queueWallet({});
    const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
    expect(r.ok).toBe(true);
  });

  // KEEP-391 (Fix-pack-4): the chain match must be performed on a normalised
  // tag so listings stored with a numeric chain id are interoperable with
  // the wallet's slug-form payload. Before this fix, a workflow listed with
  // chain="8453" rejected every legitimate Base x402 payment because the
  // wallet client always sends chain="base".
  describe("chain tag normalisation (KEEP-391)", () => {
    it("accepts caller chain=base when workflow.chain is the Base chain id 8453", async () => {
      queueWorkflow({ chain: "8453" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r.ok).toBe(true);
    });

    it("accepts caller chain=tempo when workflow.chain is Tempo mainnet id 4217", async () => {
      queueWorkflow({ chain: "4217" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r.ok).toBe(true);
    });

    it("accepts caller chain=tempo when workflow.chain is Tempo testnet id 4218", async () => {
      queueWorkflow({ chain: "4218" });
      queueWallet({});
      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r.ok).toBe(true);
    });

    it("normalises case + whitespace on slug input (Base, ' tempo ')", async () => {
      queueWorkflow({ chain: "Base" });
      queueWallet({});
      const r1 = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(r1.ok).toBe(true);

      queueWorkflow({ chain: " tempo " });
      queueWallet({});
      const r2 = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r2.ok).toBe(true);
    });

    it("still rejects when normalised wf.chain differs from caller (Base id vs tempo caller)", async () => {
      queueWorkflow({ chain: "8453" });
      const r = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });

    it("rejects an unrecognised wf.chain tag (defensive — no silent widening)", async () => {
      // wf.chain is a non-null string we cannot normalise. Treat as
      // mismatch rather than falling through to permissive null branch,
      // so a typo or future chain stored as "ethereum" can never pass
      // a stolen-HMAC attacker's request through.
      queueWorkflow({ chain: "ethereum" });
      const rBase = await verifyWorkflowBinding(SLUG, "base", CREATOR, "50000");
      expect(rBase).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });

      queueWorkflow({ chain: "1" });
      const rTempo = await verifyWorkflowBinding(SLUG, "tempo", "", "0");
      expect(rTempo).toMatchObject({
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
      });
    });
  });
});
