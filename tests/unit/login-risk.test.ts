import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHeaders = vi.fn();
const mockSelect = vi.fn();

vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

function setHeaders(values: Record<string, string | null>): void {
  const map = new Map<string, string | null>(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v])
  );
  mockHeaders.mockResolvedValueOnce({
    get: (name: string) => map.get(name.toLowerCase()) ?? null,
  });
}

function setRecentSessionCountries(countries: (string | null)[]): void {
  // assessLoginRisk makes one select call: loadRecentCountries(userId).
  // Returns rows with riskFlagsJson; the function parses out `country`.
  const recentRows = countries.map((country) =>
    country === null
      ? { riskFlagsJson: null }
      : { riskFlagsJson: JSON.stringify({ country }) }
  );

  mockSelect.mockReturnValueOnce({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(recentRows),
        }),
      }),
    }),
  });
}

import { assessLoginRisk, serializeRiskFlags } from "@/lib/security/login-risk";

beforeEach(() => {
  mockHeaders.mockReset();
  mockSelect.mockReset();
});

describe("assessLoginRisk", () => {
  it("returns NULL_RISK when CF-Connecting-IP is absent (local dev / direct origin)", async () => {
    setHeaders({ "cf-ipcountry": "AU" });
    const result = await assessLoginRisk("user_1");
    expect(result).toEqual({
      anomaly: false,
      reasons: [],
      country: null,
      region: null,
      city: null,
      recentCountries: [],
    });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns NULL_RISK when CF-IPCountry is missing despite CF-Connecting-IP", async () => {
    setHeaders({ "cf-connecting-ip": "203.0.113.1" });
    const result = await assessLoginRisk("user_1");
    expect(result.country).toBeNull();
    expect(result.anomaly).toBe(false);
  });

  it("returns NULL_RISK when CF-IPCountry is the unknown sentinel XX", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "XX",
    });
    const result = await assessLoginRisk("user_1");
    expect(result.country).toBeNull();
  });

  it("flags first_geo_attestation (not anomaly) for a user's first geo-attested session", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "au",
    });
    setRecentSessionCountries([null, null]);
    const result = await assessLoginRisk("user_1");
    expect(result.country).toBe("AU");
    expect(result.anomaly).toBe(false);
    expect(result.reasons).toEqual(["first_geo_attestation"]);
  });

  it("does not flag when login country matches a prior session country", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "AU",
    });
    setRecentSessionCountries(["AU", "AU"]);
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(false);
    expect(result.country).toBe("AU");
  });

  it("flags new_country when login country differs from every recent country", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "KR",
    });
    setRecentSessionCountries(["AU", "AU"]);
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toEqual(["new_country"]);
    expect(result.country).toBe("KR");
    expect(result.recentCountries).toEqual(["AU"]);
  });

  it("treats null-only history (pre-tracking sessions) as first_geo_attestation", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "KR",
    });
    setRecentSessionCountries([null, null, null]);
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(false);
    expect(result.reasons).toEqual(["first_geo_attestation"]);
  });

  it("ignores the current country from the recent-countries list when reporting history", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "AU",
    });
    setRecentSessionCountries(["AU", "US"]);
    const result = await assessLoginRisk("user_1");
    expect(result.recentCountries).toEqual(["US"]);
    expect(result.anomaly).toBe(false);
  });

  it("tolerates malformed risk_flags_json rows without throwing", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "KR",
    });
    mockSelect.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () =>
              Promise.resolve([
                { riskFlagsJson: "not json" },
                { riskFlagsJson: JSON.stringify({ country: "AU" }) },
              ]),
          }),
        }),
      }),
    });

    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(true);
    expect(result.recentCountries).toEqual(["AU"]);
  });
});

describe("serializeRiskFlags", () => {
  it("round-trips through JSON without losing fields", () => {
    const signal = {
      anomaly: true,
      reasons: ["new_country"] as const,
      country: "KR",
      region: "11",
      city: "Seoul",
      recentCountries: ["AU"] as const,
    };
    const serialized = serializeRiskFlags(signal);
    expect(JSON.parse(serialized)).toEqual({
      anomaly: true,
      reasons: ["new_country"],
      country: "KR",
      region: "11",
      city: "Seoul",
      recentCountries: ["AU"],
    });
  });
});
