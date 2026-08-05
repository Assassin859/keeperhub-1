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
    expect(parsed.hint).toBe(
      "Direct-execution simulation is EVM-only. Preflight with a Solana-aware client before broadcasting."
    );
    expect(parsed.hint).not.toContain("Omit simulate");
  });

  it("includes chain id for Solana devnet", () => {
    const error = buildSimulationUnsupportedChainError(103);
    const parsed = JSON.parse(error.message) as { chainId: number };
    expect(parsed.chainId).toBe(103);
  });
});
