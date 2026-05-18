/**
 * KEEP-458 protocol coverage: superfluid on Sepolia.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "superfluid";
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
