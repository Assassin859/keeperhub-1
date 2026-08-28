import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockFetch = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (url: string) => mockFetch(url),
}));

const contractCalls = vi.fn();
const CONTRACT_METHODS = [
  "uiMultiplier",
  "newUIMultiplier",
  "effectiveAt",
  "paused",
  "tokenPaused",
  "oraclePaused",
  "balanceOf",
  "latestRoundData",
] as const;

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  // Methods are assigned rather than proxied: a constructor that returns a
  // value is banned by lint, and the method set here is small and known.
  class MockContract {
    constructor(address: string) {
      for (const name of CONTRACT_METHODS) {
        (this as Record<string, unknown>)[name] = () =>
          contractCalls(address, name);
      }
    }
  }
  return { ethers: { ...actual.ethers, Contract: MockContract } };
});

import {
  __clearStockTokenCaches,
  fetchQuote,
  loadChainlinkFeeds,
  readOnChainState,
  readPosition,
  resolveStockToken,
} from "@/plugins/robinhood/steps/stock-token-core";

const CRWD = "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931";
const UNIT = BigInt("1000000000000000000");
const FOUR = BigInt(4) * UNIT;

function json(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

const ASSETS = {
  assets: [
    {
      tokenSymbol: "CRWD",
      tokenName: "CrowdStrike",
      tokenDecimals: 18,
      currentMultiplier: "4.000000000000000000",
      pendingMultiplier: "",
      status: "ASSET_STATUS_ACTIVE",
      deployments: [{ contractAddress: CRWD, chainId: 4663 }],
    },
    {
      tokenSymbol: "DELISTED",
      tokenName: "Gone",
      tokenDecimals: 18,
      currentMultiplier: "1",
      pendingMultiplier: "",
      status: "ASSET_STATUS_INACTIVE",
      deployments: [{ contractAddress: CRWD, chainId: 4663 }],
    },
    {
      tokenSymbol: "OTHERCHAIN",
      tokenName: "Elsewhere",
      tokenDecimals: 18,
      currentMultiplier: "1",
      status: "ASSET_STATUS_ACTIVE",
      deployments: [{ contractAddress: CRWD, chainId: 1 }],
    },
  ],
};

beforeEach(() => {
  __clearStockTokenCaches();
  mockFetch.mockReset();
  contractCalls.mockReset();
});

describe("resolveStockToken", () => {
  it("resolves a ticker to its address through the registry", async () => {
    mockFetch.mockReturnValue(json(ASSETS));
    const result = await resolveStockToken("crwd");
    expect(result).toEqual({
      ok: true,
      token: expect.objectContaining({ symbol: "CRWD", address: CRWD }),
    });
  });

  it("rejects a ticker that is not listed", async () => {
    mockFetch.mockReturnValue(json(ASSETS));
    const result = await resolveStockToken("NOTREAL");
    expect(result.ok).toBe(false);
  });

  it("rejects a listed but inactive asset", async () => {
    mockFetch.mockReturnValue(json(ASSETS));
    const result = await resolveStockToken("DELISTED");
    expect(result.ok).toBe(false);
  });

  it("ignores assets deployed on other chains", async () => {
    mockFetch.mockReturnValue(json(ASSETS));
    const result = await resolveStockToken("OTHERCHAIN");
    expect(result.ok).toBe(false);
  });

  it("reports a registry outage rather than throwing", async () => {
    mockFetch.mockReturnValue(json({}, false, 503));
    const result = await resolveStockToken("CRWD");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("registry");
    }
  });

  it("caches the registry across lookups", async () => {
    mockFetch.mockReturnValue(json(ASSETS));
    await resolveStockToken("CRWD");
    await resolveStockToken("CRWD");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchQuote", () => {
  it("derives quote age from generatedAt", async () => {
    const generatedAt = new Date(Date.now() - 120_000).toISOString();
    mockFetch.mockReturnValue(
      json({
        quotes: [
          {
            tokenSymbol: "AAPL",
            bid: "314.89",
            ask: "315",
            currency: "USD",
            isTradingHalt: false,
            generatedAt,
          },
        ],
      })
    );
    const quote = await fetchQuote("AAPL");
    expect(quote.bid).toBe("314.89");
    expect(quote.quoteAgeSeconds).toBeGreaterThanOrEqual(119);
    expect(quote.quoteAgeSeconds).toBeLessThanOrEqual(125);
  });

  it("carries the halt flag through", async () => {
    mockFetch.mockReturnValue(
      json({
        quotes: [
          {
            tokenSymbol: "AAPL",
            bid: "1",
            ask: "1",
            isTradingHalt: true,
            generatedAt: new Date().toISOString(),
          },
        ],
      })
    );
    await expect(fetchQuote("AAPL")).resolves.toMatchObject({
      isTradingHalt: true,
    });
  });
});

describe("loadChainlinkFeeds", () => {
  it("keys equity feeds by ticker and ignores crypto feeds", async () => {
    mockFetch.mockReturnValue(
      json([
        {
          name: "Robinhood AAPL / USD",
          proxyAddress: "0xaaa",
          heartbeat: 86_400,
        },
        {
          name: "Robinhood SGOV-USD",
          proxyAddress: "0xbbb",
          heartbeat: 86_400,
        },
        { name: "ETH / USD", proxyAddress: "0xccc", heartbeat: 86_400 },
      ])
    );
    const feeds = await loadChainlinkFeeds();
    expect([...feeds.keys()].sort()).toEqual(["AAPL", "SGOV"]);
    expect(feeds.get("AAPL")?.heartbeatSeconds).toBe(86_400);
  });
});

describe("readOnChainState", () => {
  const runner = {} as never;

  it("reports a pending corporate action only when it is still in the future", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    contractCalls.mockImplementation((_a: string, fn: string) => {
      if (fn === "uiMultiplier") {
        return Promise.resolve(UNIT);
      }
      if (fn === "newUIMultiplier") {
        return Promise.resolve(FOUR);
      }
      if (fn === "effectiveAt") {
        return Promise.resolve(BigInt(future));
      }
      return Promise.resolve(false);
    });
    const state = await readOnChainState(runner, CRWD);
    expect(state.pendingMultiplier).toBe("4.0");
    expect(state.effectiveAt).toBe(future);
  });

  it("does not report a pending action once it has landed", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    contractCalls.mockImplementation((_a: string, fn: string) => {
      if (fn === "uiMultiplier") {
        return Promise.resolve(FOUR);
      }
      if (fn === "newUIMultiplier") {
        return Promise.resolve(FOUR);
      }
      if (fn === "effectiveAt") {
        return Promise.resolve(BigInt(past));
      }
      return Promise.resolve(false);
    });
    const state = await readOnChainState(runner, CRWD);
    // The fields keep their last values after an action applies, so a naive
    // read of newUIMultiplier alone would report a permanent pending action.
    expect(state.pendingMultiplier).toBeNull();
  });

  it("degrades field by field rather than failing the whole read", async () => {
    contractCalls.mockImplementation((_a: string, fn: string) => {
      if (fn === "uiMultiplier") {
        return Promise.resolve(FOUR);
      }
      return Promise.reject(new Error("not implemented"));
    });
    const state = await readOnChainState(runner, CRWD);
    expect(state.uiMultiplier).toBe("4.0");
    expect(state.paused).toBe(false);
    expect(state.pendingMultiplier).toBeNull();
  });
});

describe("readPosition", () => {
  const runner = {} as never;
  const token = {
    symbol: "CRWD",
    name: "CrowdStrike",
    address: CRWD,
    decimals: 18,
    currentMultiplier: "4",
    pendingMultiplier: "",
    active: true,
  };

  it("reports shares and raw balance separately", async () => {
    // The live pair: balanceOf 7.572731046613574564, shares 4x that.
    contractCalls.mockImplementation((_a: string, fn: string) => {
      if (fn === "balanceOf") {
        return Promise.resolve(BigInt("7572731046613574564"));
      }
      if (fn === "uiMultiplier") {
        return Promise.resolve(FOUR);
      }
      return Promise.resolve(BigInt(0));
    });
    const position = await readPosition(runner, token, "0x1");
    expect(position.raw).toBe("7.572731046613574564");
    expect(position.ui).toBe("30.290924186454298256");
    expect(position.uiMultiplier).toBe("4.0");
  });

  it("is the identity for an unscaled token", async () => {
    contractCalls.mockImplementation((_a: string, fn: string) => {
      if (fn === "balanceOf") {
        return Promise.resolve(UNIT);
      }
      if (fn === "uiMultiplier") {
        return Promise.resolve(UNIT);
      }
      return Promise.resolve(BigInt(0));
    });
    const position = await readPosition(runner, token, "0x1");
    expect(position.ui).toBe(position.raw);
  });
});
