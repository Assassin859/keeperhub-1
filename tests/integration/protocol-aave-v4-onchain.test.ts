/**
 * Aave V4 On-Chain Integration Tests (Lido Spoke)
 *
 * Verifies that the ABI-driven Aave V4 protocol definition produces valid
 * calldata that the deployed Lido Spoke contract accepts. Runs against a
 * live Ethereum mainnet RPC endpoint.
 *
 * Uses a separate env var (INTEGRATION_TEST_MAINNET_RPC_URL) because Aave V4
 * has no Sepolia deployment - the existing INTEGRATION_TEST_RPC_URL targets
 * Sepolia and would produce address mismatches.
 *
 * Gated on INTEGRATION_TEST_MAINNET_RPC_URL - skipped in CI without it.
 */

import { ethers } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import aaveV4Def from "@/protocols/aave-v4";
import { buildCalldata } from "./_shared/build-calldata";

const RPC_URL = process.env.INTEGRATION_TEST_MAINNET_RPC_URL;
const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const CORE_HUB = "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9";

// Assertion model:
//  - Read tests: let the RPC call fail loudly. A success path asserts the
//    decoded return has the expected shape; anything else (network error,
//    ABI mismatch, decode failure) surfaces as a real test failure instead
//    of being swallowed.
//  - Write tests: use provider.call (not estimateGas) against a zero-balance
//    TEST_ADDRESS. The contract should either (a) revert with CALL_EXCEPTION
//    on business logic, or (b) succeed and return "0x" for void functions.
//    Both outcomes prove the deployed bytecode understood the calldata.
//    What we reject: calldata-level ethers errors (INVALID_ARGUMENT, BAD_DATA,
//    BUFFER_OVERRUN) which would indicate the ABI doesn't match the
//    deployed contract. Observed: supply reverts (ERC20 transferFrom fails
//    on zero allowance); setUsingAsCollateral silently succeeds on
//    reserveId=0 because the Spoke no-ops on nonexistent reserves.
describe.skipIf(!RPC_URL)("Aave V4 Lido Spoke on-chain integration", () => {
  // Route every RPC call through the failover manager so a primary-endpoint
  // hiccup falls back to the secondary instead of failing the test. The
  // primary URL respects INTEGRATION_TEST_MAINNET_RPC_URL (the original
  // gate); the fallback comes from the chains-config used in production.
  let manager: RpcProviderManager;

  beforeAll(async () => {
    if (!RPC_URL) {
      return;
    }
    manager = await getRpcProviderFromUrls(
      RPC_URL,
      getRpcUrlByChainId(MAINNET_CHAIN_ID, "fallback"),
      MAINNET_CHAIN_ID,
      "ethereum"
    );
  });

  it("getReserveId: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata({
      protocol: aaveV4Def,
      actionSlug: "get-reserve-id",
      sampleInputs: { hub: CORE_HUB, assetId: "0" },
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getReserveId", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("getUserSuppliedAssets: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata({
      protocol: aaveV4Def,
      actionSlug: "get-user-supplied-assets",
      sampleInputs: { reserveId: "0", user: TEST_ADDRESS },
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getUserSuppliedAssets", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("getUserDebt: eth_call returns two decodable uint256 values", async () => {
    const { to, data, contract } = buildCalldata({
      protocol: aaveV4Def,
      actionSlug: "get-user-debt",
      sampleInputs: { reserveId: "0", user: TEST_ADDRESS },
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getUserDebt", result);
    expect(decoded).toBeDefined();
    expect(decoded.length).toBeGreaterThanOrEqual(2);
    expect(typeof decoded[0]).toBe("bigint");
    expect(typeof decoded[1]).toBe("bigint");
  }, 15_000);

  it("getUserAccountData: eth_call returns a decodable struct with named fields", async () => {
    const { to, data, contract } = buildCalldata({
      protocol: aaveV4Def,
      actionSlug: "get-user-account-data",
      sampleInputs: { user: TEST_ADDRESS },
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getUserAccountData", result);
    expect(decoded).toBeDefined();
    const struct = decoded[0];
    expect(typeof struct.healthFactor).toBe("bigint");
    expect(typeof struct.totalCollateralValue).toBe("bigint");
    expect(typeof struct.riskPremium).toBe("bigint");
    expect(typeof struct.borrowCount).toBe("bigint");
  }, 15_000);

  it("supply: deployed bytecode accepts the calldata", async () => {
    const { to, data } = buildCalldata({
      protocol: aaveV4Def,
      actionSlug: "supply",
      sampleInputs: {
        reserveId: "0",
        amount: "1000000000000000000",
        onBehalfOf: TEST_ADDRESS,
      },
      chainId: CHAIN_ID,
    });

    await expectCallAcceptedByBytecode(manager, { to, data });
  }, 15_000);

  it("setUsingAsCollateral: deployed bytecode accepts the calldata", async () => {
    const { to, data } = buildCalldata({
      protocol: aaveV4Def,
      actionSlug: "set-collateral",
      sampleInputs: {
        reserveId: "0",
        usingAsCollateral: "true",
        onBehalfOf: TEST_ADDRESS,
      },
      chainId: CHAIN_ID,
    });

    await expectCallAcceptedByBytecode(manager, { to, data });
  }, 15_000);
});

/**
 * Asserts the deployed bytecode accepted our calldata: either the call
 * returned cleanly (void functions return "0x") or reverted at the contract
 * level (CALL_EXCEPTION). Any other error class means the ABI doesn't match
 * what's deployed. The call is routed through the failover manager so a
 * primary-RPC hiccup falls back to the secondary endpoint.
 */
async function expectCallAcceptedByBytecode(
  manager: RpcProviderManager,
  tx: { to: string; data: string }
): Promise<void> {
  try {
    const result = await manager.executeWithFailover((p) =>
      p.call({ ...tx, from: TEST_ADDRESS })
    );
    expect(result).toMatch(/^0x/);
  } catch (err: unknown) {
    expect(err).toMatchObject({ code: "CALL_EXCEPTION" });
  }
}
