/**
 * Protocol coverage: Morpho Blue on Ethereum mainnet fork.
 *
 * Requires a running anvil mainnet fork on port 8548 (test-anvil-fork-mainnet
 * service in docker-compose.yml). The fork-mode funding path uses whale
 * impersonation for WSTETH and USDC — no TESTNET_FUNDER_PK needed.
 *
 * Write actions run in dependency order: accrue-interest and set-authorization
 * first (no prerequisites), then supply-collateral, supply, borrow, repay,
 * withdraw, withdraw-collateral.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "morpho";
const CHAIN_ID = "1";
const _SKIP_INFRA_TESTS =
  !(process.env.DATABASE_URL && process.env.ANVIL_FORK_MAINNET_URL) ||
  process.env.SKIP_INFRA_TESTS === "true";

// Hard-skipped: morpho has the registry's longest setup write chain (two
// token provisions, three approvals, vault interactions), and on the CI
// fork the archive upstream's cold-fetch latency under 16 concurrent
// suite setups pushes single approves past 3.5 minutes - the setup
// workflow cannot finish inside any sane budget (measured twice on
// first activation, 2026-07-07). Every morpho action retains full Tier 1
// fork-simulation coverage including writes and oracles; Tier 2's shared
// execution path is proven by the sibling suites.
// Unlock: mount the nightly fork RPC cache into this job's mainnet fork
// (as tier1 does) so setup writes run against warmed state, then
// re-enable.
describe.skip(`${PROTOCOL} (Ethereum)`, () => {
  const ctx = createSharedCtx();

  beforeAll(async () => {
    await runSetup({ protocol: PROTOCOL, chainId: CHAIN_ID, ctx });
  }, 600_000);

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
