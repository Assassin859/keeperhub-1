import { describe, expect, it } from "vitest";

import { classifyExecutionError } from "@/lib/errors/classify";
import { ErrorCategory } from "@/lib/logging";
import { scrubRpcUrls } from "@/lib/rpc/scrub-rpc-urls";

describe("classifyExecutionError", () => {
  it("classifies a missing integration credential as a user config error", () => {
    const result = classifyExecutionError(
      "Safe API key is required. Configure it in the integration settings."
    );
    expect(result).toEqual({
      errorCategory: ErrorCategory.CONFIGURATION,
      errorType: "user",
      // User-config failures carry no system error code.
      code: null,
    });
  });

  it("defaults unmatched messages to system so real engine faults still page", () => {
    const result = classifyExecutionError("some unexpected internal failure");
    expect(result.errorType).toBe("system");
    expect(result.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
  });

  it("classifies null/empty messages as system", () => {
    expect(classifyExecutionError(null).errorType).toBe("system");
    expect(classifyExecutionError("   ").errorType).toBe("system");
  });

  it("still classifies RPC failover errors after URL scrubbing", () => {
    // Error messages are scrubbed of keyed RPC URLs before classification;
    // the scrubber must not disturb the prose the patterns match on.
    const fakeDrpcKey = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAAAAAAAAAAAA";
    const raw =
      "Event query failed: RPC failed on both endpoints. Primary: could not coalesce error. " +
      `Fallback: server response 400 Bad Request (info={ "requestUrl": "https://lb.drpc.live/ethereum/${fakeDrpcKey}" })`;
    const result = classifyExecutionError(scrubRpcUrls(raw));
    expect(result).toEqual({
      errorCategory: ErrorCategory.NETWORK_RPC,
      errorType: "system",
      code: "N-0001",
    });
  });
});
