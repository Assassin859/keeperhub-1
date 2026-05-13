import { describe, expect, it } from "vitest";
import {
  formatActionConfigValidationResponse,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";

function actionNode(
  actionType: string,
  config: Record<string, unknown>,
  id = "node-1"
) {
  return {
    id,
    type: "action",
    data: {
      label: actionType,
      type: "action",
      config: {
        actionType,
        ...config,
      },
    },
  };
}

describe("validateWorkflowActionConfigs", () => {
  it("rejects unknown namespaced action types before persistence", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("webhook/send", { webhookUrl: "https://example.com" }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_ACTION_TYPE",
        path: "nodes[0].data.config.actionType",
        actionType: "webhook/send",
      }),
    ]);
  });

  it("rejects wrong config keys and missing required fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("discord/send-message", { Message: "hello" }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNKNOWN_FIELD",
          path: "nodes[0].data.config.Message",
          field: "Message",
          actionType: "discord/send-message",
        }),
        expect.objectContaining({
          code: "MISSING_REQUIRED_FIELD",
          path: "nodes[0].data.config.discordMessage",
          field: "discordMessage",
          actionType: "discord/send-message",
        }),
      ])
    );
  });

  it("rejects template values in typed protocol address fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("aave-v3/supply", {
        network: "1",
        asset: "{{trigger.walletAddress}}",
        amount: "1000000000000000000",
        onBehalfOf: "0x0000000000000000000000000000000000000001",
      }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[0].data.config.asset",
          field: "asset",
          expected: "address",
        }),
      ])
    );
  });

  it("accepts registered actions with valid config", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("discord/send-message", { discordMessage: "hello" }),
      actionNode("webhook/send-webhook", {
        webhookUrl: "https://example.com",
        webhookMethod: "POST",
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it.each([
    "Database Query",
    "HTTP Request",
    "Condition",
    "For Each",
    "Collect",
  ])("keeps legacy system action %s compatible", (actionType) => {
    const result = validateWorkflowActionConfigs([
      actionNode(actionType, {
        url: "https://example.com",
        method: "GET",
        arbitraryLegacyField: true,
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });
});

describe("formatActionConfigValidationResponse", () => {
  it("returns a structured 422 body shape for route handlers", () => {
    const validation = validateWorkflowActionConfigs([
      actionNode("webhook/send", {}),
    ]);

    expect(formatActionConfigValidationResponse(validation)).toEqual({
      error: "INVALID_ACTION_CONFIG",
      message:
        "Workflow contains invalid action configuration. Fix the listed fields and save again.",
      invalidFields: validation.issues,
    });
  });
});
