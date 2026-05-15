import { beforeEach, describe, expect, it, vi } from "vitest";

// KEEP-444: the HTTP Request step gains a per-node `timeout` and a
// `failOnError` flag. When failOnError is false, a non-2xx response or a
// timeout returns `{ success: true, data: null, status, error }` to the next
// node instead of failing the step -- so aggregator workflows can treat one
// dead source as a miss rather than a workflow failure.

vi.mock("server-only", () => ({}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(),
}));

import { safeFetch } from "@/lib/safe-fetch";
import {
  httpRequest,
  resolveFailOnError,
  resolveTimeoutMs,
} from "@/lib/workflow/nodes/http-request/step";

const mockedSafeFetch = vi.mocked(safeFetch);

type MockResponseOptions = {
  ok: boolean;
  status: number;
  body?: unknown;
  text?: string;
};

function mockResponse(opts: MockResponseOptions): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    headers: {
      get: (key: string) =>
        key.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: () => Promise.resolve(opts.body ?? {}),
    text: () => Promise.resolve(opts.text ?? JSON.stringify(opts.body ?? {})),
  } as unknown as Response;
}

const BASE_INPUT = {
  endpoint: "https://api.example.com/quote",
  httpMethod: "GET",
};

describe("resolveTimeoutMs", () => {
  it("uses the 5s default when no timeout is provided", () => {
    expect(resolveTimeoutMs(undefined)).toBe(5000);
  });

  it("accepts a numeric timeout", () => {
    expect(resolveTimeoutMs(10)).toBe(10_000);
  });

  it("coerces a string timeout from the visual editor", () => {
    expect(resolveTimeoutMs("15")).toBe(15_000);
  });

  it("clamps below the 1s minimum", () => {
    expect(resolveTimeoutMs(0)).toBe(1000);
  });

  it("clamps above the 30s maximum", () => {
    expect(resolveTimeoutMs(120)).toBe(30_000);
  });

  it("falls back to the default for non-numeric input", () => {
    expect(resolveTimeoutMs("not-a-number")).toBe(5000);
  });
});

describe("resolveFailOnError", () => {
  it("defaults to true when unset", () => {
    expect(resolveFailOnError(undefined)).toBe(true);
  });

  it("stays true for an explicit true", () => {
    expect(resolveFailOnError(true)).toBe(true);
  });

  it("is false for a boolean false", () => {
    expect(resolveFailOnError(false)).toBe(false);
  });

  it("is false for the string 'false' the editor may persist", () => {
    expect(resolveFailOnError("false")).toBe(false);
  });

  it("stays true for the string 'true'", () => {
    expect(resolveFailOnError("true")).toBe(true);
  });
});

describe("httpRequest timeout wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes an AbortSignal to safeFetch derived from the timeout", async () => {
    mockedSafeFetch.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { quote: 1 } })
    );

    await httpRequest({ ...BASE_INPUT, timeout: 10 });

    expect(mockedSafeFetch).toHaveBeenCalledOnce();
    const init = mockedSafeFetch.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("httpRequest failOnError behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success with parsed data on a 2xx response", async () => {
    mockedSafeFetch.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { quote: 42 } })
    );

    const result = await httpRequest(BASE_INPUT);

    expect(result).toEqual({
      success: true,
      data: { quote: 42 },
      status: 200,
    });
  });

  it("hard-fails on a non-2xx response by default", async () => {
    mockedSafeFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 503, text: "upstream down" })
    );

    const result = await httpRequest(BASE_INPUT);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(503);
      expect(result.error).toContain("503");
    }
  });

  it("soft-fails on a non-2xx response when failOnError is false", async () => {
    mockedSafeFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 503, text: "upstream down" })
    );

    const result = await httpRequest({ ...BASE_INPUT, failOnError: false });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
      expect(result.status).toBe(503);
      expect(result.error).toContain("503");
    }
  });

  it("hard-fails on a thrown error (e.g. timeout) by default", async () => {
    mockedSafeFetch.mockRejectedValue(new Error("The operation timed out"));

    const result = await httpRequest(BASE_INPUT);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("timed out");
    }
  });

  it("soft-fails on a thrown error when failOnError is false, with null status", async () => {
    mockedSafeFetch.mockRejectedValue(new Error("The operation timed out"));

    const result = await httpRequest({ ...BASE_INPUT, failOnError: false });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
      expect(result.status).toBeNull();
      expect(result.error).toContain("timed out");
    }
  });

  it("always hard-fails endpoint validation errors, even with failOnError false", async () => {
    const result = await httpRequest({
      endpoint: "   ",
      httpMethod: "GET",
      failOnError: false,
    });

    expect(result.success).toBe(false);
    expect(mockedSafeFetch).not.toHaveBeenCalled();
  });
});
