/**
 * E2E integration tests for `lib/safe/roles-orchestrator` against an anvil
 * fork of Sepolia, where the canonical Safe v1.4.1 + Zodiac Roles v2.1
 * contracts already live.
 *
 * What this proves vs. the unit tests:
 *
 *   - Unit tests cover pure data-shape transformations and DB-wrapper reads.
 *   - These tests prove the orchestrator's calldata + chain-state interpretation
 *     work against REAL Safe / Zodiac bytecode. They catch ABI drift, decoder
 *     mismatches, and condition-tree encoding bugs that mocks cannot see.
 *
 * Setup: `docker compose --profile test up -d test-anvil-fork` brings up an
 * anvil instance forked from the public Sepolia RPC on port 8547. Skipped
 * when `SKIP_INFRA_TESTS=true` or when the fork is unreachable, matching
 * the existing pattern in this directory.
 *
 * DB is mocked at the function-call level (we are testing the orchestrator's
 * chain interactions, not its DB writes). Where the orchestrator queries
 * DB-cached state we return whatever the test scenario needs.
 */

import type { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The DB seam: read calls return controlled fixtures, write calls are
// captured but not persisted. Tests assert on chain state primarily.
const dbSelectMock = vi.fn();
const dbInsertReturning = vi.fn().mockResolvedValue([]);
const dbUpdate = vi.fn().mockResolvedValue(undefined);
const dbDelete = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: dbSelectMock,
          orderBy: () => ({
            limit: dbSelectMock,
          }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: dbInsertReturning }),
        returning: dbInsertReturning,
      }),
    }),
    update: () => ({
      set: () => ({
        where: dbUpdate,
      }),
    }),
    delete: () => ({
      where: dbDelete,
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      // Inline-run the transaction body against the same mock surface,
      // so the orchestrator's tx.insert/update/delete chains compose.
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: dbSelectMock }),
          }),
        }),
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({ returning: dbInsertReturning }),
            returning: dbInsertReturning,
          }),
        }),
        update: () => ({ set: () => ({ where: dbUpdate }) }),
        delete: () => ({ where: dbDelete }),
      };
      return await fn(tx);
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationWallets: {},
  safeRoleAllowances: {},
  safeRoleDirectRules: {},
  safeRoleProtocols: {},
  safeRoles: {
    id: "id",
    safeWalletId: "safeWalletId",
    roleType: "roleType",
    status: "status",
  },
  safeWallets: {},
  paraWallets: {},
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  eq: () => ({}),
  inArray: () => ({}),
  sql: () => ({}),
}));

// Override RPC URL lookup so the orchestrator's internal
// getRpcProviderFromUrls calls hit our fork instead of public Sepolia.
vi.mock("@/lib/rpc/rpc-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rpc/rpc-config")>(
    "@/lib/rpc/rpc-config"
  );
  return {
    ...actual,
    getRpcUrlByChainId: (chainId: number, _kind: "primary" | "fallback") => {
      if (chainId === SEPOLIA_CHAIN_ID) {
        return FORK_URL;
      }
      return actual.getRpcUrlByChainId(chainId, _kind);
    },
  };
});

// Wallet helpers: bypass Turnkey, return an ethers.Wallet bound to our
// fork as the org's "Turnkey EOA". The orchestrator treats it as opaque
// (it just calls signer.sendTransaction etc.) so this works.
vi.mock("@/lib/para/wallet-helpers", () => ({
  initializeWalletSigner: () => Promise.resolve(getFork().wallet),
  getOrganizationWallet: () =>
    Promise.resolve({
      id: "test-wallet-row",
      organizationId: TEST_ORG_ID,
      walletAddress: getFork().ownerAddress,
      provider: "turnkey",
      turnkeySubOrgId: "test-suborg",
      isActive: true,
    }),
  getOrganizationWalletAddress: () => Promise.resolve(getFork().ownerAddress),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { reconcileSafeRoleFromChain } from "@/lib/safe/roles-orchestrator";
import {
  deployFreshSafe,
  FORK_URL,
  getFork,
  isForkReachable,
  SEPOLIA_CHAIN_ID,
} from "./safe-fork-helpers";

// ---------------------------------------------------------------------------
// Skip detection
// ---------------------------------------------------------------------------

const skipForCi = process.env.SKIP_INFRA_TESTS === "true";
const forkUp = skipForCi ? false : await isForkReachable();
const shouldSkip = skipForCi || !forkUp;

const TEST_ORG_ID = "test-org-orchestrator-fork";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkip)(
  "roles-orchestrator (anvil fork integration)",
  () => {
    let provider: ethers.JsonRpcProvider;
    let wallet: ethers.Wallet;

    beforeAll(() => {
      const ctx = getFork();
      provider = ctx.provider;
      wallet = ctx.wallet;
    });

    afterAll(() => {
      provider.destroy();
    });

    it("(a) reconcile on a bare Safe with no modifier returns installed:false, reason:no-roles-modifier", {
      timeout: 60_000,
    }, async () => {
      const { safeAddress } = await deployFreshSafe(wallet);

      // Fixture: orchestrator's `findRoleForSafe` lookup returns no DB row.
      dbSelectMock.mockResolvedValueOnce([]);

      const result = await reconcileSafeRoleFromChain({
        id: "safe-1",
        organizationId: TEST_ORG_ID,
        chainId: SEPOLIA_CHAIN_ID,
        safeAddress,
        // Remaining SafeWallet fields are unread on the no-modifier branch
        // but typed as required, so we stub them.
        status: "deployed",
        isSigningActive: true,
      } as never);

      expect(result).toMatchObject({
        success: true,
        installed: false,
        reason: "no-roles-modifier",
      });
    });
  }
);
