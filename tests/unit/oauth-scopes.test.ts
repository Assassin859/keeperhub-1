import { describe, expect, it } from "vitest";
import { isToolAllowed } from "@/lib/mcp/oauth-scopes";

describe("oauth-scopes — prepare_test_pin_data (TESTWF-06)", () => {
  it("mcp:read allows prepare_test_pin_data", () => {
    expect(isToolAllowed("prepare_test_pin_data", "mcp:read")).toBe(true);
  });

  it("mcp:write allows prepare_test_pin_data (write inherits read)", () => {
    expect(isToolAllowed("prepare_test_pin_data", "mcp:write")).toBe(true);
  });

  it("mcp:admin allows prepare_test_pin_data", () => {
    expect(isToolAllowed("prepare_test_pin_data", "mcp:admin")).toBe(true);
  });

  it("empty scope denies prepare_test_pin_data", () => {
    expect(isToolAllowed("prepare_test_pin_data", "")).toBe(false);
  });

  it("unknown scope denies prepare_test_pin_data", () => {
    expect(isToolAllowed("prepare_test_pin_data", "bogus:scope")).toBe(false);
  });
});
