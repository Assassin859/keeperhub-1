import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "chronicle";
const CHAIN_ID = "11155111";
// Runs against the anvil Sepolia fork CI stands up on localhost:8547
// (gas for the self-kiss setup via anvil_setBalance; no live funder).
// PROTOCOL_E2E_SEPOLIA_FORK signals the fork is up and the chains row
// points at it; skip cleanly when absent.
const SKIP_INFRA_TESTS =
  !process.env.DATABASE_URL ||
  !process.env.PROTOCOL_E2E_SEPOLIA_FORK ||
  process.env.SKIP_INFRA_TESTS === "true";

// Temporarily disabled on the fork. Root cause (measured locally with
// real signing, 2026-07-02): anvil lazily fetches touched contract
// state from its upstream on first access, and the free public upstream
// throttles those fetches, so a write touching a cold contract takes
// ~200s to mine (kiss #1: 3m19s measured). Every one of chronicle's six
// setup kisses targets a different oracle contract, and each read
// fixture touches yet another feed, so the suite needs ~20 minutes of
// first-touch fetches - past the 300s setup wait and past the fork's
// own ~15-minute survival window on a non-archive upstream. Superfluid
// passes on the same fork because its operations reuse the same
// contracts, which warm once during setup.
// Unlock: provision a dedicated archive-grade Sepolia upstream for the
// fork (ANVIL_FORK_SEPOLIA_URL secret, mirroring ANVIL_FORK_MAINNET_URL)
// and re-enable; until then the suite would be red on every CI run.
describe.skip(`${PROTOCOL} (Sepolia)`, () => {
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
