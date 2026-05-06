import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogSystemError = vi.fn();
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { INFRASTRUCTURE: "INFRASTRUCTURE" },
  logSystemError: (...args: unknown[]) => mockLogSystemError(...args),
}));

import { fallbackCompleteExecution } from "@/lib/workflow/executor/execution-fallback";

describe("fallbackCompleteExecution", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  const mockFetch = vi.fn();

  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    vi.stubGlobal("fetch", mockFetch);
    process.env.NEXT_PUBLIC_APP_URL = "https://app.keeperhub.io";
    process.env.EVENTS_SERVICE_API_KEY = "test-service-key";
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("logs error and returns early when base URL is not configured", async () => {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_APP_URL");

    await fallbackCompleteExecution({
      executionId: "exec_no_url",
      status: "error",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogSystemError).toHaveBeenCalledWith(
      "INFRASTRUCTURE",
      expect.stringContaining("Missing required config"),
      expect.any(Error),
      { execution_id: "exec_no_url" }
    );
  });

  it("logs error and returns early when service key is not configured", async () => {
    Reflect.deleteProperty(process.env, "EVENTS_SERVICE_API_KEY");

    await fallbackCompleteExecution({
      executionId: "exec_no_key",
      status: "error",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogSystemError).toHaveBeenCalledWith(
      "INFRASTRUCTURE",
      expect.stringContaining("EVENTS_SERVICE_API_KEY"),
      expect.any(Error),
      { execution_id: "exec_no_key" }
    );
  });

  it("sends PATCH request to internal executions endpoint", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await fallbackCompleteExecution({
      executionId: "exec_1",
      status: "success",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/internal/executions/exec_1"),
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Service-Key": expect.any(String),
        }),
      })
    );
  });

  it("sends correct status and error in request body", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await fallbackCompleteExecution({
      executionId: "exec_1",
      status: "error",
      error: "step 3 failed",
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body).toEqual({ status: "error", error: "step 3 failed" });
  });

  it("logs success message when HTTP request succeeds", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await fallbackCompleteExecution({
      executionId: "exec_1",
      status: "error",
      error: "workflow failed",
    });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("exec_1")
    );
    expect(mockLogSystemError).not.toHaveBeenCalled();
  });

  it("calls logSystemError when HTTP request fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await fallbackCompleteExecution({
      executionId: "exec_2",
      status: "error",
      error: "workflow failed",
    });

    expect(mockLogSystemError).toHaveBeenCalledWith(
      "INFRASTRUCTURE",
      expect.stringContaining("HTTP fallback also failed"),
      expect.any(Error),
      { execution_id: "exec_2" }
    );
  });

  it("calls logSystemError when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("connection refused"));

    await fallbackCompleteExecution({
      executionId: "exec_3",
      status: "error",
    });

    expect(mockLogSystemError).toHaveBeenCalledWith(
      "INFRASTRUCTURE",
      expect.stringContaining("HTTP fallback also failed"),
      expect.any(Error),
      { execution_id: "exec_3" }
    );
  });

  it("does not throw when fallback fails", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    await expect(
      fallbackCompleteExecution({
        executionId: "exec_4",
        status: "error",
      })
    ).resolves.toBeUndefined();
  });
});
