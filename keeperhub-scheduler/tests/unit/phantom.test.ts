import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
vi.mock("../../lib/http-client.js", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));

import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom.js";

describe("createPhantomExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs a phantom row and returns the new execution id", async () => {
    apiRequest.mockResolvedValue({ executionId: "exec_123" });

    const id = await createPhantomExecution("wf_1", "schedule");

    expect(id).toBe("exec_123");
    const [path, options] = apiRequest.mock.calls[0];
    expect(path).toBe("/api/internal/executions");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      workflowId: "wf_1",
      status: "phantom",
      triggerSource: "schedule",
    });
  });

  it("forwards userId when provided (block path)", async () => {
    apiRequest.mockResolvedValue({ executionId: "exec_456" });

    await createPhantomExecution("wf_1", "block", "owner_1");

    const body = JSON.parse(apiRequest.mock.calls[0][1].body);
    expect(body.userId).toBe("owner_1");
    expect(body.triggerSource).toBe("block");
  });

  it("returns undefined when the API call fails (best-effort)", async () => {
    apiRequest.mockRejectedValue(new Error("api down"));

    const id = await createPhantomExecution("wf_1", "schedule");

    expect(id).toBeUndefined();
  });
});

describe("failPhantomExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PATCHes the phantom row to a coded error", async () => {
    apiRequest.mockResolvedValue({ success: true });

    await failPhantomExecution("exec_123", "CS-0001", "dispatch failed");

    const [path, options] = apiRequest.mock.calls[0];
    expect(path).toBe("/api/internal/executions/exec_123");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({
      status: "system_error",
      error: "dispatch failed",
      errorCode: "CS-0001",
    });
  });

  it("swallows API errors (the reaper is the backstop)", async () => {
    apiRequest.mockRejectedValue(new Error("api down"));

    await expect(
      failPhantomExecution("exec_123", "CS-0001", "dispatch failed"),
    ).resolves.toBeUndefined();
  });
});
