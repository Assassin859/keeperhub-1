import { describe, expect, it } from "vitest";
import { synthesiseProtocolTemplate } from "@/lib/workflow/codegen/protocol-synthesiser";

describe("synthesiseProtocolTemplate", () => {
  it("returns null for non-protocol action ids", () => {
    expect(synthesiseProtocolTemplate("web3/check-balance")).toBeNull();
    expect(synthesiseProtocolTemplate("not-a-protocol/anything")).toBeNull();
    expect(synthesiseProtocolTemplate("malformed-no-slash")).toBeNull();
  });

  describe("ccip-check-bridge-balance (read, user-specified address)", () => {
    const actionId = "chainlink/ccip-check-bridge-balance";

    it("emits a viem readContract template with sepolia config", () => {
      const out = synthesiseProtocolTemplate(actionId, {
        network: "11155111",
        contractAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
      });

      expect(out).not.toBeNull();
      const code = out as string;

      expect(code).toContain('import { createPublicClient, http } from "viem"');
      expect(code).toContain('import { sepolia } from "viem/chains"');
      expect(code).toContain(
        'const CONTRACT_ADDRESS = "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05" as const'
      );
      expect(code).toContain(
        "export async function ccipCheckBridgeBalanceStep"
      );
      expect(code).toContain('"use step"');
      expect(code).toContain("client.readContract");
      expect(code).toContain('functionName: "balanceOf"');
      expect(code).toContain("args: [input.account]");
      expect(code).toContain("chain: sepolia");
      expect(code).toContain("process.env.SEPOLIA_RPC_URL");

      // No write-only constructs leaking into a read template
      expect(code).not.toContain("walletClient");
      expect(code).not.toContain("WALLET_PRIVATE_KEY");
      expect(code).not.toContain("simulateContract");

      // Must not be the stub
      expect(code).not.toContain("Executing action");
    });

    it("emits a placeholder address when user-specified address is missing", () => {
      const out = synthesiseProtocolTemplate(actionId, {
        network: "11155111",
      });
      expect(out).toContain(
        '"0x0000000000000000000000000000000000000000" as const'
      );
      expect(out).toContain(
        "// this contract address is user-specified at runtime"
      );
    });

    it("falls back to defineChain when no network is selected", () => {
      const out = synthesiseProtocolTemplate(actionId, {});
      expect(out).toContain('import { defineChain } from "viem"');
      expect(out).toContain("// no network selected on this node");
    });
  });

  describe("ccip-approve-bridge-token (write)", () => {
    const actionId = "chainlink/ccip-approve-bridge-token";

    it("emits a viem write template with simulate, write, wait", () => {
      const out = synthesiseProtocolTemplate(actionId, {
        network: "11155111",
        contractAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
      });

      expect(out).not.toBeNull();
      const code = out as string;

      expect(code).toContain(
        'import { createPublicClient, createWalletClient, http } from "viem"'
      );
      expect(code).toContain(
        'import { privateKeyToAccount } from "viem/accounts"'
      );
      expect(code).toContain('import { sepolia } from "viem/chains"');
      expect(code).toContain(
        "export async function ccipApproveBridgeTokenStep"
      );

      // Pipeline: simulate → write → wait
      expect(code).toContain("publicClient.simulateContract");
      expect(code).toContain("walletClient.writeContract(request)");
      expect(code).toContain("publicClient.waitForTransactionReceipt");

      expect(code).toContain('functionName: "approve"');
      // approve takes (address spender, uint256 amount). Address passes through,
      // uint256 is wrapped with BigInt.
      expect(code).toContain("input.spender, BigInt(input.amount)");

      // Output type for write actions is the fixed transaction shape
      // biome-ignore lint/suspicious/noTemplateCurlyInString: assertion against literal output
      expect(code).toContain("transactionHash: `0x${string}`");
      expect(code).toContain("gasUsed: string");

      // No payable variant value leak (approve is non-payable)
      expect(code).not.toContain("input.ethValue");
    });
  });

  describe("type emission edge cases", () => {
    it("maps an address input field to a viem-shaped Input type", () => {
      const out = synthesiseProtocolTemplate(
        "chainlink/ccip-check-bridge-balance",
        { network: "11155111", contractAddress: "0xabc" }
      );
      // biome-ignore lint/suspicious/noTemplateCurlyInString: assertion against literal output
      expect(out).toContain("account: `0x${string}`");
    });

    it("maps a uint256 input field to string and casts via BigInt at call site", () => {
      const out = synthesiseProtocolTemplate(
        "chainlink/ccip-approve-bridge-token",
        { network: "11155111", contractAddress: "0xabc" }
      );
      expect(out).toContain("amount: string");
      expect(out).toContain("BigInt(input.amount)");
    });
  });
});
