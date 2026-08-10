import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  resolveOrganizationId: vi.fn().mockResolvedValue({
    organizationId: "org-1",
    authMethod: "oauth",
    apiKeyId: null,
    scope: "mcp:read",
  }),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/mcp/oauth-scopes", () => ({
  SCOPE_MCP_READ: "mcp:read",
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi
    .fn()
    .mockResolvedValue("0xwalletaddress1234567890123456789012345678"),
}));

const mockEstimateGas = vi.fn();
vi.mock("@/lib/contracts/multicall3", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  MULTICALL3_ABI: [
    { name: "aggregate3", type: "function", inputs: [], outputs: [] },
  ],
}));

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        aggregate3 = { estimateGas: mockEstimateGas };
      },
    },
  };
});

const mockValidateAndParseCalls = vi.fn();
const mockEncodeCall3Array = vi.fn();
vi.mock("@/plugins/web3/steps/batch-write-contract-core", () => ({
  validateAndParseCalls: (...args: unknown[]) =>
    mockValidateAndParseCalls(...args),
  encodeCall3Array: (...args: unknown[]) => mockEncodeCall3Array(...args),
}));

const mockGetRpcProvider = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
}));

import { POST } from "@/app/api/gas/estimate/route";

const WORK_ABI = JSON.stringify([
  {
    type: "function",
    name: "work",
    stateMutability: "nonpayable",
    inputs: [
      { name: "network", type: "bytes32" },
      { name: "args", type: "bytes" },
    ],
    outputs: [],
  },
]);

const SAMPLE_CALLS = [
  { contractAddress: "0x1111111111111111111111111111111111111111", args: [] },
];

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/gas/estimate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) => fn({}),
  });
  mockValidateAndParseCalls.mockReturnValue({
    calls: [{ contractAddress: SAMPLE_CALLS[0].contractAddress, args: [] }],
  });
  mockEncodeCall3Array.mockReturnValue({
    call3Array: [
      {
        target: SAMPLE_CALLS[0].contractAddress,
        allowFailure: true,
        callData: "0xdeadbeef",
      },
    ],
  });
  mockEstimateGas.mockResolvedValue(BigInt(150_000));
});

describe("POST /api/gas/estimate - batch-write-contract", () => {
  it("estimates gas for a valid batch-write-contract config", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: WORK_ABI,
          abiFunction: "work",
          calls: JSON.stringify(SAMPLE_CALLS),
        },
      })
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { estimatedGas: string };
    expect(data.estimatedGas).toBe("150000");
    expect(mockValidateAndParseCalls).toHaveBeenCalledWith(
      JSON.stringify(SAMPLE_CALLS),
      expect.objectContaining({ name: "work" })
    );
    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
  });

  it("rejects when calls is missing", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: { abi: WORK_ABI, abiFunction: "work" },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("abi, abiFunction, and calls are required");
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  it("rejects invalid ABI JSON", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: "not json",
          abiFunction: "work",
          calls: JSON.stringify(SAMPLE_CALLS),
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("Invalid ABI JSON");
  });

  it("rejects when the function is not found in the ABI", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: WORK_ABI,
          abiFunction: "doesNotExist",
          calls: JSON.stringify(SAMPLE_CALLS),
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("not found in ABI");
  });

  it("propagates a validateAndParseCalls error", async () => {
    mockValidateAndParseCalls.mockReturnValue({
      calls: [],
      error: "Call at index 0 missing contractAddress",
    });

    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: WORK_ABI,
          abiFunction: "work",
          calls: JSON.stringify([{ args: [] }]),
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("Call at index 0 missing contractAddress");
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  it("propagates an encodeCall3Array error", async () => {
    mockEncodeCall3Array.mockReturnValue({
      call3Array: [],
      error: "Failed to encode call at index 0: wrong number of arguments",
    });

    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: WORK_ABI,
          abiFunction: "work",
          calls: JSON.stringify(SAMPLE_CALLS),
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("Failed to encode call at index 0");
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  it("rejects template references in calls", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: WORK_ABI,
          abiFunction: "work",
          calls: "{{@prep:Prep.calls}}",
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("template references");
    expect(mockValidateAndParseCalls).not.toHaveBeenCalled();
  });

  it("rejects a native calls array containing a template reference in an arg", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: WORK_ABI,
          abiFunction: "work",
          calls: [
            {
              contractAddress: SAMPLE_CALLS[0].contractAddress,
              args: ["{{@prep:Prep.arg}}"],
            },
          ],
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("template references");
    expect(mockValidateAndParseCalls).not.toHaveBeenCalled();
  });

  it("rejects a native calls array containing a template reference in contractAddress", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: WORK_ABI,
          abiFunction: "work",
          calls: [{ contractAddress: "{{@prep:Prep.target}}", args: [] }],
        },
      })
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("template references");
    expect(mockValidateAndParseCalls).not.toHaveBeenCalled();
  });

  it("accepts calls as a native array in the request body", async () => {
    const response = await POST(
      makeRequest({
        chainId: 1,
        actionSlug: "batch-write-contract",
        config: {
          abi: WORK_ABI,
          abiFunction: "work",
          calls: SAMPLE_CALLS,
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockValidateAndParseCalls).toHaveBeenCalledWith(
      SAMPLE_CALLS,
      expect.objectContaining({ name: "work" })
    );
  });
});
