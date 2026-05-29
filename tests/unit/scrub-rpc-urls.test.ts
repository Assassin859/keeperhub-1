import { describe, expect, it } from "vitest";
import { scrubRpcUrls } from "@/lib/rpc/scrub-rpc-urls";

// Fake key markers. Long enough to trip the generic 32+ char path mask;
// recognizable in greps so any regression that lets them through is loud.
const FAKE_ALCHEMY_KEY = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAA";
const FAKE_INFURA_KEY = "FAKE_TEST_KEY_DO_NOT_USE_BBBBBBBBBB";
const FAKE_QUICKNODE_KEY = "FAKE_TEST_KEY_DO_NOT_USE_CCCCCCCCCC";
const FAKE_ANKR_KEY = "FAKE_TEST_KEY_DO_NOT_USE_DDDDDDDDDD";

describe("scrubRpcUrls", () => {
  it("masks Alchemy /v2/<key> paths and keeps host visible", () => {
    const input = `POST https://avax-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY} failed`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    expect(out).toContain("avax-mainnet.g.alchemy.com");
    expect(out).toContain("/v2/[REDACTED]");
  });

  it("masks Infura /v3/<key> paths", () => {
    const input = `https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_INFURA_KEY);
    expect(out).toContain("/v3/[REDACTED]");
  });

  it("masks QuickNode subdomain key paths", () => {
    const input = `https://example.quiknode.pro/${FAKE_QUICKNODE_KEY}/eth/`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_QUICKNODE_KEY);
  });

  it("masks Ankr premium /<chain>/<key> paths", () => {
    const input = `https://rpc.ankr.com/eth/${FAKE_ANKR_KEY}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ANKR_KEY);
  });

  it("drops query strings entirely", () => {
    const input = `https://rpc.example.com/foo?apikey=${FAKE_ALCHEMY_KEY}&debug=1`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    expect(out).toContain("[REDACTED-QUERY]");
  });

  it("scrubs wss:// URLs the same way", () => {
    const input = `wss://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
  });

  it("masks multiple URLs in one string", () => {
    const input =
      `tried https://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY} ` +
      `then https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    expect(out).not.toContain(FAKE_INFURA_KEY);
  });

  it("stops at delimiting characters in error prose", () => {
    const input = `(POST https://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY}) failed`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    // The closing paren should survive intact.
    expect(out).toContain(") failed");
  });

  it("leaves plain prose without URLs untouched", () => {
    expect(scrubRpcUrls("connection refused")).toBe("connection refused");
  });

  it("returns empty string for empty input", () => {
    expect(scrubRpcUrls("")).toBe("");
  });

  it("does not over-mask short path segments like /v2/ alone", () => {
    // Bare provider path without a secret - nothing to redact.
    const input = "https://example.com/api/v1/health";
    const out = scrubRpcUrls(input);
    expect(out).toContain("example.com");
    expect(out).toContain("/api/v1/health");
  });
});
