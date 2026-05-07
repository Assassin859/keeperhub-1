import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ explorerConfigs: {} }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/lib/explorer", () => ({
  getAddressUrl: (): string => "",
  getTransactionUrl: (): string => "",
}));

import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";

const SEQUENCER_ADDRESS = "0xdA0Ab1e0017DEbCd72Be8599041a2aa3bA7e740F";
const D3M_JOB_ADDRESS = "0x2Ea4aDE144485895B923466B4521F5ebC03a0AeF";
const CRON_D3M_JOB_KEY =
  "0x43524f4e5f44334d5f4a4f420000000000000000000000000000000000000000";

const GET_ADDRESS_ABI = [
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [{ name: "_key", type: "bytes32" }],
    outputs: [{ name: "addr", type: "address" }],
  },
] as const;

type ExecuteWithFailover = <T>(
  op: (provider: unknown) => Promise<T>
) => Promise<T>;

function createAdapter(): EvmChainAdapter {
  const gasStrategy = {
    getGasConfig: vi.fn(),
  };
  const nonceManager = { getNextNonce: vi.fn() };
  return new EvmChainAdapter(
    1,
    gasStrategy as unknown as ConstructorParameters<typeof EvmChainAdapter>[1],
    nonceManager as unknown as ConstructorParameters<typeof EvmChainAdapter>[2]
  );
}

function createRpcManagerWithCallReturning(rawResult: string): {
  executeWithFailover: ExecuteWithFailover;
  callMock: ReturnType<typeof vi.fn>;
} {
  const callMock = vi.fn().mockResolvedValue(rawResult);
  const provider = { call: callMock };
  const executeWithFailover: ExecuteWithFailover = async (op) =>
    await op(provider);
  return { executeWithFailover, callMock };
}

describe("EvmChainAdapter.readContract — BaseContract name collision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the ABI function result for `getAddress`, not the contract address", async () => {
    const adapter = createAdapter();

    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address"],
      [D3M_JOB_ADDRESS]
    );
    const { executeWithFailover, callMock } =
      createRpcManagerWithCallReturning(encoded);

    const result = (await adapter.readContract(
      { executeWithFailover } as unknown as Parameters<
        EvmChainAdapter["readContract"]
      >[0],
      {
        contractAddress: SEQUENCER_ADDRESS,
        abi: GET_ADDRESS_ABI as unknown as ethers.InterfaceAbi,
        functionKey: "getAddress(bytes32)",
        args: [CRON_D3M_JOB_KEY],
        isView: true,
      }
    )) as string;

    expect(callMock).toHaveBeenCalledTimes(1);
    expect(ethers.getAddress(result)).toBe(ethers.getAddress(D3M_JOB_ADDRESS));
    expect(ethers.getAddress(result)).not.toBe(
      ethers.getAddress(SEQUENCER_ADDRESS)
    );
  });

  it("uses staticCall when isView is false (nonpayable read)", async () => {
    const adapter = createAdapter();

    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address"],
      [D3M_JOB_ADDRESS]
    );
    const { executeWithFailover, callMock } =
      createRpcManagerWithCallReturning(encoded);

    const result = (await adapter.readContract(
      { executeWithFailover } as unknown as Parameters<
        EvmChainAdapter["readContract"]
      >[0],
      {
        contractAddress: SEQUENCER_ADDRESS,
        abi: GET_ADDRESS_ABI as unknown as ethers.InterfaceAbi,
        functionKey: "getAddress(bytes32)",
        args: [CRON_D3M_JOB_KEY],
        isView: false,
      }
    )) as string;

    expect(callMock).toHaveBeenCalledTimes(1);
    expect(ethers.getAddress(result)).toBe(ethers.getAddress(D3M_JOB_ADDRESS));
  });
});
