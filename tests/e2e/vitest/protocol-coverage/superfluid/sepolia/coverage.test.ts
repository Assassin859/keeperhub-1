/**
 * Protocol coverage: superfluid on Sepolia.
 *
 * Gating and infra contract match the sibling aave-v3 coverage.test.ts in
 * this directory.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "superfluid";
const CHAIN_ID = "11155111";
// Runs against the anvil Sepolia fork CI stands up on localhost:8547
// (funding via cheatcodes; no live-testnet funder). PROTOCOL_E2E_SEPOLIA_FORK
// signals the fork is up and the chains row points at it; without it,
// beforeAll would throw against a live RPC - skip cleanly instead.
const SKIP_INFRA_TESTS =
  !process.env.DATABASE_URL ||
  !process.env.PROTOCOL_E2E_SEPOLIA_FORK ||
  process.env.SKIP_INFRA_TESTS === "true";

describe.skipIf(SKIP_INFRA_TESTS)(`${PROTOCOL} (Sepolia)`, () => {
  const ctx = createSharedCtx();

  beforeAll(async () => {
    await runSetup({ protocol: PROTOCOL, chainId: CHAIN_ID, ctx });
  }, 420_000);

  afterAll(async () => {
    await cleanupAll(ctx);
  });

  describe("read", () => {
    runPhaseFixtures({
      protocol: PROTOCOL,
      chainId: CHAIN_ID,
      phase: "read",
      ctx,
    });
  });

  describe("write", () => {
    runPhaseFixtures({
      protocol: PROTOCOL,
      chainId: CHAIN_ID,
      phase: "write",
      ctx,
    });
  });
});
