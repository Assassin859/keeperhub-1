/**
 * Superfluid On-Chain Integration Tests
 *
 * Verifies that the Superfluid protocol definition produces valid calldata
 * the deployed CFA forwarder, GDA forwarder, and SuperToken contracts
 * accept on Sepolia. Catches contract dispatch and ABI-shape mistakes the
 * unit-test layer cannot see.
 *
 * Coverage: every action declared by the protocol gets at least one
 * dispatch test (read decodes, write encodes without ABI errors).
 *
 * Gated on INTEGRATION_TEST_RPC_URL env var - skipped in CI without it.
 */

import { ethers } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import type {
  ProtocolAction,
  ProtocolContract,
  ProtocolDefinition,
} from "@/lib/protocol-registry";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import superfluidDef, {
  CFA_FORWARDER_ADDRESS,
  GDA_FORWARDER_ADDRESS,
} from "@/protocols/superfluid";

const RPC_URL = process.env.INTEGRATION_TEST_RPC_URL;
const CHAIN_ID = "11155111";
const SEPOLIA_CHAIN_ID = 11_155_111;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
// Distinct from TEST_ADDRESS: estimateGas runs with `from: TEST_ADDRESS`,
// and Superfluid's CFA rejects sender == flowOperator (self-grant).
const TEST_OPERATOR = "0x0000000000000000000000000000000000000002";

// fUSDCx on Sepolia. The forwarders validate the token argument against the
// Superfluid host registry and revert for unknown addresses, so reads need
// a real SuperToken. fUSDCx is the canonical Sepolia test token; an account
// with no flows returns 0, which is exactly what we want for assertions.
const SEPOLIA_FUSDCX = "0xb598E6C621618a9f63788816ffb50Ee2862D443B";
// Underlying fUSDC for fUSDCx; getUnderlyingToken should return this
// (proves we're decoding the right slot, not just any address).
const SEPOLIA_FUSDC = "0xe72f289584eDA2bE69Cfe487f4638F09bAc920Db";

// Common dummy values for write-action inputs. estimateGas will revert
// with business reverts for most of these (insufficient balance, no flow
// to update, etc.) -- that is fine; we only assert the failure mode is
// not an ABI/encoding error.
const DUMMY_AMOUNT_WEI = "1000000000000000000"; // 1e18
const DUMMY_FLOW_RATE = "1000000"; // wei/sec, small but non-zero
const DUMMY_UNITS = "1";
const DUMMY_PERMISSIONS_ALL = "7"; // create+update+delete bitmap
const DUMMY_BYTES = "0x";

// Markers we treat as failures: ABI/calldata mistakes plus the
// "contract reverted with no data" pattern. The latter is the KEEP-456
// failure mode -- routing into a non-existent SuperToken proxy returned a
// CALL_EXCEPTION with empty revert data, and the previous loose guard
// silently tolerated it. Anything else (require(false), insufficient
// balance, CFA_*/GDA_* business reverts, etc.) is fine: writes are called
// from an unfunded TEST_ADDRESS and naturally revert at the contract layer.
//
// `data="0x"` (with the closing quote) is the precise KEEP-456 signature:
// real reverts have hex content between the quotes (`data="0x08c..."`),
// so the literal `0x"` only appears when the revert data is empty.
const DISPATCH_FAILURE_RE =
  /INVALID_ARGUMENT|could not decode|invalid function|missing revert data|data="0x"/;

function buildCalldata(
  protocol: ProtocolDefinition,
  actionSlug: string,
  sampleInputs: Record<string, string>,
  contractAddressOverride?: string
): {
  to: string;
  data: string;
  action: ProtocolAction;
  contract: ProtocolContract;
} {
  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    throw new Error(`Action ${actionSlug} not found`);
  }

  const contract = protocol.contracts[action.contract];
  if (!contract.abi) {
    throw new Error(`Contract ${action.contract} has no ABI`);
  }

  const contractAddress =
    contractAddressOverride ?? contract.addresses[CHAIN_ID];
  if (!contractAddress) {
    throw new Error(
      `Contract ${action.contract} not on chain ${CHAIN_ID} and no override given`
    );
  }

  const rawArgs = action.inputs.map(
    (inp) => sampleInputs[inp.name] ?? inp.default ?? ""
  );

  const abi = JSON.parse(contract.abi);
  const functionAbi = abi.find(
    (f: { name: string; type: string }) =>
      f.type === "function" && f.name === action.function
  );
  // Reproduce the production pipeline: reshape flat args into tuples per
  // ABI, then coerce stringly-typed leaves (bool "false" -> false) before
  // encoding. Same order as plugins/web3/steps/write-contract-core.ts.
  const reshaped = reshapeArgsForAbi(rawArgs, functionAbi);
  const args = coerceArgsForAbi(reshaped, functionAbi);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(action.function, args);

  return { to: contractAddress, data, action, contract };
}

describe.skipIf(!RPC_URL)("Superfluid on-chain integration", () => {
  let manager: RpcProviderManager;

  beforeAll(async () => {
    if (!RPC_URL) {
      return;
    }
    manager = await getRpcProviderFromUrls(
      RPC_URL,
      getRpcUrlByChainId(SEPOLIA_CHAIN_ID, "fallback"),
      SEPOLIA_CHAIN_ID,
      "sepolia"
    );
  });

  // -- helpers -------------------------------------------------------------

  async function callAndDecode(
    slug: string,
    inputs: Record<string, string>,
    contractAddressOverride?: string
  ): Promise<{
    decoded: ethers.Result;
    contract: ProtocolContract;
    action: ProtocolAction;
    to: string;
  }> {
    const { to, data, contract, action } = buildCalldata(
      superfluidDef,
      slug,
      inputs,
      contractAddressOverride
    );
    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult(action.function, result);
    return { decoded, contract, action, to };
  }

  // Returns the error message from estimateGas, or "" if it succeeded.
  // Callers either assert the empty string (positive simulation) or assert
  // the message does not match DISPATCH_FAILURE_RE (any non-routing-error
  // revert is acceptable).
  async function estimateGasError(
    slug: string,
    inputs: Record<string, string>,
    contractAddressOverride?: string
  ): Promise<string> {
    const { to, data } = buildCalldata(
      superfluidDef,
      slug,
      inputs,
      contractAddressOverride
    );
    try {
      await manager.executeWithFailover((p) =>
        p.estimateGas({ to, data, from: TEST_ADDRESS })
      );
      return "";
    } catch (error) {
      return String(error);
    }
  }

  // -- CFA reads -----------------------------------------------------------

  it("get-flow: returns the four expected CFA flow-info outputs", async () => {
    const { decoded, to } = await callAndDecode("get-flow", {
      token: SEPOLIA_FUSDCX,
      sender: TEST_ADDRESS,
      receiver: TEST_ADDRESS,
    });
    expect(to).toBe(CFA_FORWARDER_ADDRESS);
    expect(decoded).toHaveLength(4);
  }, 15_000);

  it("get-cfa-net-flow: dispatches to cfaForwarder.getAccountFlowrate", async () => {
    const { decoded, to } = await callAndDecode("get-cfa-net-flow", {
      token: SEPOLIA_FUSDCX,
      account: TEST_ADDRESS,
    });
    expect(to).toBe(CFA_FORWARDER_ADDRESS);
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  // -- GDA reads -----------------------------------------------------------

  it("get-net-flow: dispatches to gdaForwarder.getNetFlow (combined CFA+GDA)", async () => {
    const { decoded, to } = await callAndDecode("get-net-flow", {
      token: SEPOLIA_FUSDCX,
      account: TEST_ADDRESS,
    });
    expect(to).toBe(GDA_FORWARDER_ADDRESS);
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  // -- SuperToken reads (userSpecifiedAddress) -----------------------------

  it("get-super-token-balance: dispatches to the user-supplied SuperToken", async () => {
    const { decoded } = await callAndDecode(
      "get-super-token-balance",
      { account: TEST_ADDRESS },
      SEPOLIA_FUSDCX
    );
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("get-underlying-token: returns the fUSDC underlying for fUSDCx", async () => {
    const { decoded } = await callAndDecode(
      "get-underlying-token",
      {},
      SEPOLIA_FUSDCX
    );
    expect((decoded[0] as string).toLowerCase()).toBe(
      SEPOLIA_FUSDC.toLowerCase()
    );
  }, 15_000);

  // -- CFA writes ----------------------------------------------------------

  it("create-flow: encodes against cfaForwarder.createFlow", async () => {
    const msg = await estimateGasError("create-flow", {
      token: SEPOLIA_FUSDCX,
      sender: TEST_ADDRESS,
      receiver: TEST_ADDRESS,
      flowRate: DUMMY_FLOW_RATE,
      userData: DUMMY_BYTES,
    });
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  it("update-flow: encodes against cfaForwarder.updateFlow", async () => {
    const msg = await estimateGasError("update-flow", {
      token: SEPOLIA_FUSDCX,
      sender: TEST_ADDRESS,
      receiver: TEST_ADDRESS,
      flowRate: DUMMY_FLOW_RATE,
      userData: DUMMY_BYTES,
    });
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  it("delete-flow: encodes against cfaForwarder.deleteFlow", async () => {
    const msg = await estimateGasError("delete-flow", {
      token: SEPOLIA_FUSDCX,
      sender: TEST_ADDRESS,
      receiver: TEST_ADDRESS,
      userData: DUMMY_BYTES,
    });
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  // -- GDA writes ----------------------------------------------------------

  it("create-pool: simulates successfully against gdaForwarder.createPool", async () => {
    // GDA createPool only writes pool metadata -- no sender balance, no
    // pre-existing state required. We can assert positive simulation
    // success, which (unlike the loose .not.toMatch guard) catches the
    // class of routing bug KEEP-456 surfaced.
    const msg = await estimateGasError("create-pool", {
      token: SEPOLIA_FUSDCX,
      admin: TEST_ADDRESS,
      transferabilityForUnitsOwner: "false",
      distributionFromAnyAddress: "false",
    });
    expect(msg).toBe("");
  }, 15_000);

  it("update-member-units: encodes against gdaForwarder.updateMemberUnits", async () => {
    const msg = await estimateGasError("update-member-units", {
      pool: TEST_ADDRESS,
      member: TEST_ADDRESS,
      units: DUMMY_UNITS,
      userData: DUMMY_BYTES,
    });
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  it("distribute: encodes against gdaForwarder.distribute", async () => {
    const msg = await estimateGasError("distribute", {
      token: SEPOLIA_FUSDCX,
      from: TEST_ADDRESS,
      pool: TEST_ADDRESS,
      amount: DUMMY_AMOUNT_WEI,
      userData: DUMMY_BYTES,
    });
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  it("distribute-flow: encodes int96 flowRate against gdaForwarder.distributeFlow", async () => {
    const msg = await estimateGasError("distribute-flow", {
      token: SEPOLIA_FUSDCX,
      from: TEST_ADDRESS,
      pool: TEST_ADDRESS,
      flowRate: DUMMY_FLOW_RATE,
      userData: DUMMY_BYTES,
    });
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  it("connect-pool: encodes against gdaForwarder.connectPool", async () => {
    // Not convertible to toBe(""): the GDA host dispatches into the pool
    // address as a contract call during connectPool, and TEST_ADDRESS has
    // no deployed code -- so estimateGas reverts with `CallUtils: target
    // revert()`. That is not a routing/ABI failure (the revert *does*
    // have data, just from a different source), so it correctly does not
    // match DISPATCH_FAILURE_RE. Strengthening to toBe("") would need a
    // deployed contract at the pool address that implements the expected
    // pool interface (any Superfluid pool would do); out of scope for
    // "no on-chain state dependency" tests.
    const msg = await estimateGasError("connect-pool", {
      pool: TEST_ADDRESS,
      userData: DUMMY_BYTES,
    });
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  // -- SuperToken writes (userSpecifiedAddress) ----------------------------

  it("wrap: encodes uint256 amount against superToken.upgrade", async () => {
    const msg = await estimateGasError(
      "wrap",
      { amount: DUMMY_AMOUNT_WEI },
      SEPOLIA_FUSDCX
    );
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  it("unwrap: encodes uint256 amount against superToken.downgrade", async () => {
    const msg = await estimateGasError(
      "unwrap",
      { amount: DUMMY_AMOUNT_WEI },
      SEPOLIA_FUSDCX
    );
    expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
  }, 15_000);

  it("grant-flow-operator: simulates successfully against cfaForwarder.updateFlowOperatorPermissions", async () => {
    // KEEP-456: routed through the CFAv1Forwarder, not the SuperToken proxy.
    // Asserts the call actually simulates (estimateGas returns) -- the previous
    // "tolerate any revert" pattern hid a routing bug because the SuperToken's
    // proxy reverts on the Sepolia fUSDCx test token. The CFAv1Forwarder is
    // the canonical entry point and works for any registered SuperToken.
    //
    // Note: this on-chain test is gated on INTEGRATION_TEST_RPC_URL and
    // skipped in CI. The CI-side regression guard for the routing change
    // lives in tests/unit/superfluid-protocol.test.ts ("grant-flow-operator
    // action" describe block, asserting `contract === "cfaForwarder"`).
    const msg = await estimateGasError("grant-flow-operator", {
      token: SEPOLIA_FUSDCX,
      flowOperator: TEST_OPERATOR,
      permissions: DUMMY_PERMISSIONS_ALL,
      flowRateAllowance: DUMMY_FLOW_RATE,
    });
    expect(msg).toBe("");
  }, 15_000);

  // -- Coverage check ------------------------------------------------------

  it("every declared action has at least one dispatch test in this file", () => {
    const declared = new Set(superfluidDef.actions.map((a) => a.slug));
    const tested = new Set([
      "get-flow",
      "get-cfa-net-flow",
      "get-net-flow",
      "get-super-token-balance",
      "get-underlying-token",
      "create-flow",
      "update-flow",
      "delete-flow",
      "create-pool",
      "update-member-units",
      "distribute",
      "distribute-flow",
      "connect-pool",
      "wrap",
      "unwrap",
      "grant-flow-operator",
    ]);
    const missing = [...declared].filter((s) => !tested.has(s));
    const stale = [...tested].filter((s) => !declared.has(s));
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });
});

// Not gated on RPC: validates the regex shape that the on-chain block above
// relies on to catch routing regressions like KEEP-456 (calling into a
// non-existent proxy returns no revert data). If someone tightens or relaxes
// DISPATCH_FAILURE_RE without updating these samples, this fails -- the
// regex itself is the load-bearing piece of the hardening; the on-chain
// block can't exercise it without an actual routing bug to reproduce.
describe("DISPATCH_FAILURE_RE shape", () => {
  it("matches the `missing revert data` ethers v6 error shape", () => {
    const sample =
      'Error: missing revert data (action="estimateGas", data=null, reason=null, transaction={ "data": "0x...", "from": "0x...", "to": "0x..." }, invocation=null, revert=null, code=CALL_EXCEPTION, version=6.16.0)';
    expect(sample).toMatch(DISPATCH_FAILURE_RE);
  });

  it('matches CALL_EXCEPTION with empty data="0x" (proxy returned no revert data)', () => {
    const sample =
      'Error: execution reverted (action="estimateGas", data="0x", reason=null, transaction={ "to": "0x..." }, code=CALL_EXCEPTION, version=6.16.0)';
    expect(sample).toMatch(DISPATCH_FAILURE_RE);
  });

  it('does NOT misfire on `data="0x..."` with actual revert data', () => {
    // Guards against the obvious regression of writing
    // `/data="0x/` (no closing quote) which would match every revert.
    const sample =
      'Error: execution reverted: "X" (action="estimateGas", data="0x08c379a0deadbeef", code=CALL_EXCEPTION, version=6.16.0)';
    expect(sample).not.toMatch(DISPATCH_FAILURE_RE);
  });

  it("matches ABI encoding errors (INVALID_ARGUMENT)", () => {
    const sample =
      'Error: invalid BigNumberish value (argument="value", value="abc", code=INVALID_ARGUMENT, version=6.16.0)';
    expect(sample).toMatch(DISPATCH_FAILURE_RE);
  });

  it("does NOT match a normal business revert with populated revert data", () => {
    // Real Sepolia revert from connect-pool against TEST_ADDRESS: the GDA
    // calls into the "pool" address and gets a real revert string back.
    // This is the failure mode we want to tolerate -- contract reached,
    // protocol-level revert with data, not a routing/dispatch bug.
    const sample =
      'Error: execution reverted: "CallUtils: target revert()" (action="estimateGas", data="0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001a43616c6c5574696c733a20746172676574207265766572742829000000000000", reason="CallUtils: target revert()", code=CALL_EXCEPTION, version=6.16.0)';
    expect(sample).not.toMatch(DISPATCH_FAILURE_RE);
  });
});
