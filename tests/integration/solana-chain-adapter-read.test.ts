import "dotenv/config";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

import { getSolanaProviderFromUrls } from "@/lib/rpc/provider-factory";
import { PUBLIC_RPCS } from "@/lib/rpc/rpc-config";
import { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";

const DEVNET_CHAIN_ID = 103;
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

describe("SolanaChainAdapter — devnet integration", () => {
  it("getBalance returns positive lamports for system program account", {
    timeout: 30_000,
  }, async () => {
    const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, () =>
      getSolanaProviderFromUrls(
        PUBLIC_RPCS.SOLANA_DEVNET,
        undefined,
        "Solana Devnet"
      )
    );
    const balance = await adapter.getBalance(
      null as never,
      SYSTEM_PROGRAM_ADDRESS
    );
    expect(typeof balance).toBe("bigint");
    expect(balance).toBeGreaterThan(BigInt(0));
  });
});
