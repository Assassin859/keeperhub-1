import { describe, expect, it } from "vitest";
import { buildSimulationUnsupportedChainError } from "@/lib/mcp/tools";

describe("buildSimulationUnsupportedChainError", () => {
  it("returns JSON with simulation_unsupported_chain code", () => {
    const error = buildSimulationUnsupportedChainError(101);
    const parsed = JSON.parse(error.message) as {
      code: string;
      chainId: number;
      hint: string;
    };
    expect(parsed.code).toBe("simulation_unsupported_chain");
    expect(parsed.chainId).toBe(101);
    expect(parsed.hint).toContain("EVM-only");
  });

  it("includes chain id for Solana devnet", () => {
    const error = buildSimulationUnsupportedChainError(103);
    const parsed = JSON.parse(error.message) as { chainId: number };
    expect(parsed.chainId).toBe(103);
  });
});
