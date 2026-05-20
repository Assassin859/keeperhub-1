/**
 * Protocol coverage: aave-v3 on Sepolia.
 *
 * Setup runs once (funds wallet, approves DAI to Aave Pool), then read and
 * write fixtures execute as parallel `test()` calls within their `describe`.
 *
 * Each test inserts a workflow into the DB, POSTs to the keeperhub server's
 * webhook endpoint at PROTOCOL_E2E_BASE_URL (default http://localhost:3000),
 * and polls workflow_executions for success. The suite therefore needs:
 *   - a running keeperhub server reachable at PROTOCOL_E2E_BASE_URL
 *   - DATABASE_URL pointing at the same DB the server is using
 *   - a Turnkey-provisioned test wallet seeded in organization_wallets
 *   - the chains it exercises in the server's CHAIN_RPC_CONFIG
 *
 * Gated on DATABASE_URL (with the standard SKIP_INFRA_TESTS escape hatch),
 * matching the convention in this directory's sibling e2e suites. Picked
 * up by `pnpm test:e2e:vitest`, which runs in the e2e-vitest-ephemeral CI
 * job - the only place the full stack stands up.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "aave-v3";
const CHAIN_ID = "11155111";
const SKIP_INFRA_TESTS =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

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
