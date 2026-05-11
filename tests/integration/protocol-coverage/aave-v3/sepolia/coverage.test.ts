/**
 * KEEP-458 protocol coverage: aave-v3 on Sepolia.
 *
 * Setup runs once (funds wallet, approves DAI to Aave Pool), then read and
 * write fixtures execute as parallel `test()` calls within their `describe`.
 * Gated on `SEPOLIA_RPC_URL`; falls back to skip when unset (mirrors
 * `tests/integration/protocol-superfluid-onchain.test.ts:37`).
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "aave-v3";
const CHAIN_ID = "11155111";
const RPC_PRESENT = Boolean(process.env.SEPOLIA_RPC_URL);

describe.skipIf(!RPC_PRESENT)(`${PROTOCOL} (Sepolia)`, () => {
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
