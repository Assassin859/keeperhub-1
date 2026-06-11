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
// Suite needs a funded Sepolia EOA to top up the test wallet via
// `ensureNativeGas` in setup. Without TESTNET_FUNDER_PK, beforeAll throws
// before any test runs — skip cleanly instead so CI environments without
// the funder provisioned (PR / staging-push) stay green.
const SKIP_INFRA_TESTS =
  !(process.env.DATABASE_URL && process.env.TESTNET_FUNDER_PK) ||
  process.env.SKIP_INFRA_TESTS === "true";

describe.skipIf(SKIP_INFRA_TESTS)(`${PROTOCOL} (Sepolia)`, () => {
  const ctx = createSharedCtx();

  beforeAll(async () => {
    await runSetup({ protocol: PROTOCOL, chainId: CHAIN_ID, ctx });
  }, 240_000);

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
