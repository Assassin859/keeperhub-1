import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

import { getAddressBalanceStep } from "@/plugins/blockscout/steps/get-address-balance";
import { getTokenInfoStep } from "@/plugins/blockscout/steps/get-token-info";
import { getTransactionStep } from "@/plugins/blockscout/steps/get-transaction";

function mockFetchOnce(body: unknown, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

function lastFetchUrl(): string {
  const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  return String(calls.at(-1)?.[0]);
}

describe("blockscout get-address-balance", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns balance and metadata from the default instance", async () => {
    mockFetchOnce({
      hash: "0xabc",
      coin_balance: "12345",
      is_contract: false,
      ens_domain_name: "vitalik.eth",
    });

    const result = await getAddressBalanceStep({ address: "0xabc" });

    expect(result).toEqual({
      success: true,
      address: "0xabc",
      balance: "12345",
      isContract: false,
      ensName: "vitalik.eth",
    });
    expect(lastFetchUrl()).toContain("https://eth.blockscout.com/api/v2/addresses/0xabc");
  });

  it("uses the configured instance URL and appends the API key", async () => {
    mockFetchCredentials.mockResolvedValue({
      BLOCKSCOUT_API_URL: "https://base.blockscout.com/",
      BLOCKSCOUT_API_KEY: "secret",
    });
    mockFetchOnce({ hash: "0xabc", coin_balance: "0" });

    await getAddressBalanceStep({ address: "0xabc", integrationId: "int-1" });

    const url = lastFetchUrl();
    expect(url).toContain("https://base.blockscout.com/api/v2/addresses/0xabc");
    expect(url).toContain("apikey=secret");
  });

  it("rejects an empty address without calling fetch", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getAddressBalanceStep({ address: "  " });

    expect(result).toEqual({ success: false, error: "Address is required." });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps a 404 to a not-found error", async () => {
    mockFetchOnce({}, { ok: false, status: 404 });
    const result = await getAddressBalanceStep({ address: "0xabc" });

    expect(result).toEqual({
      success: false,
      error: "Not found on this Blockscout instance.",
    });
  });
});

describe("blockscout get-transaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flattens transaction details", async () => {
    mockFetchOnce({
      hash: "0xtx",
      status: "ok",
      value: "1000",
      from: { hash: "0xfrom" },
      to: { hash: "0xto" },
      block_number: 42,
      fee: { value: "21" },
      method: "transfer",
    });

    const result = await getTransactionStep({ txHash: "0xtx" });

    expect(result).toEqual({
      success: true,
      hash: "0xtx",
      status: "ok",
      value: "1000",
      from: "0xfrom",
      to: "0xto",
      blockNumber: 42,
      fee: "21",
      method: "transfer",
    });
  });

  it("rejects an empty transaction hash", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getTransactionStep({ txHash: "" });

    expect(result).toEqual({
      success: false,
      error: "Transaction hash is required.",
    });
  });
});

describe("blockscout get-token-info", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns token metadata", async () => {
    mockFetchOnce({
      address: "0xtoken",
      name: "Tether USD",
      symbol: "USDT",
      decimals: "6",
      total_supply: "9000",
      type: "ERC-20",
      holders_count: "100",
    });

    const result = await getTokenInfoStep({ tokenAddress: "0xtoken" });

    expect(result).toEqual({
      success: true,
      address: "0xtoken",
      name: "Tether USD",
      symbol: "USDT",
      decimals: "6",
      totalSupply: "9000",
      type: "ERC-20",
      holders: "100",
    });
  });

  it("rejects an empty token address", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getTokenInfoStep({ tokenAddress: "" });

    expect(result).toEqual({
      success: false,
      error: "Token address is required.",
    });
  });
});
