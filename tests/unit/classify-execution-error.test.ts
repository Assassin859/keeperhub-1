import { describe, expect, it } from "vitest";

import { classifyExecutionError } from "@/lib/errors/classify";
import { ErrorCategory } from "@/lib/logging";

describe("classifyExecutionError", () => {
  it("classifies a missing integration credential as a user config error", () => {
    const result = classifyExecutionError(
      "Safe API key is required. Configure it in the integration settings."
    );
    expect(result).toEqual({
      errorCategory: ErrorCategory.CONFIGURATION,
      errorType: "user",
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
});
