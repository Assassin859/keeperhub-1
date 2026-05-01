import { describe, expect, it } from "vitest";

import {
  findBareAtLiterals,
  isInputSchemaPresent,
} from "@/lib/mcp/listing-validators";

const triggerNode = (config: Record<string, unknown>) => ({
  id: "trigger-1",
  type: "trigger",
  data: {
    label: "Manual Trigger",
    type: "trigger",
    config: { triggerType: "Manual", ...config },
  },
});

const actionNode = (config: Record<string, unknown>) => ({
  id: "action-1",
  type: "action",
  data: {
    label: "Some Action",
    type: "action",
    config,
  },
});

describe("findBareAtLiterals", () => {
  it("returns empty when nodes is not an array", () => {
    expect(findBareAtLiterals(null)).toEqual([]);
    expect(findBareAtLiterals(undefined)).toEqual([]);
    expect(findBareAtLiterals({})).toEqual([]);
    expect(findBareAtLiterals("nodes")).toEqual([]);
  });

  it("returns empty for clean node configs", () => {
    const nodes = [
      triggerNode({}),
      actionNode({ network: "1", actionType: "web3/read" }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("detects @40 trapped from autocomplete", () => {
    const nodes = [actionNode({ address: "@40", actionType: "web3/read" })];
    expect(findBareAtLiterals(nodes)).toEqual(["@40"]);
  });

  it("detects @trigger-1 left orphaned by autocomplete dismissal", () => {
    const nodes = [
      actionNode({
        condition: "@trigger-1 < 100",
        actionType: "Condition",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual(["@trigger-1"]);
  });

  it("ignores wrapped {{@nodeId:Label.field}} references", () => {
    const nodes = [
      actionNode({
        condition:
          "{{@price-1:Get Token Price.price}} < {{@trigger-1:Manual Trigger.threshold}}",
        actionType: "Condition",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("ignores email-like patterns", () => {
    const nodes = [
      actionNode({
        recipient: "support@example.com",
        actionType: "notify/email",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("skips code/* action types to avoid TS-decorator false positives", () => {
    const nodes = [
      {
        id: "code-1",
        type: "action",
        data: {
          label: "Custom Code",
          type: "action",
          config: {
            actionType: "code/run-code",
            code: "@Component({ selector: 'foo' })\nclass Foo {}",
          },
        },
      },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("finds multiple literals across multiple nodes", () => {
    const nodes = [
      actionNode({ address: "@40", actionType: "web3/read" }),
      actionNode({ token: "@bar-2", actionType: "web3/read" }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual(["@40", "@bar-2"]);
  });

  it("walks nested config objects and arrays", () => {
    const nodes = [
      actionNode({
        actionType: "web3/read",
        nested: {
          deeper: { value: "@40" },
          list: ["clean", "{{@trigger-1:Manual Trigger.foo}}", "@bad"],
        },
      }),
    ];
    expect(findBareAtLiterals(nodes).sort()).toEqual(["@40", "@bad"]);
  });

  it("ignores nodes with no config block", () => {
    const nodes = [
      { id: "x", type: "action", data: { label: "no config" } },
      { id: "y", type: "action" },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("does not flag mid-token @ characters", () => {
    const nodes = [
      actionNode({
        message: "discord://channel/123#general",
        url: "https://api.example.com/v1/path?token=foo@bar",
        actionType: "notify/webhook",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });
});

describe("isInputSchemaPresent", () => {
  it("accepts a JSON-schema-shaped object", () => {
    expect(
      isInputSchemaPresent({
        type: "object",
        properties: { address: { type: "string" } },
        required: ["address"],
      })
    ).toBe(true);
  });

  it("accepts an empty object (zero-input workflows)", () => {
    expect(isInputSchemaPresent({})).toBe(true);
    expect(isInputSchemaPresent({ type: "object" })).toBe(true);
  });

  it("rejects null", () => {
    expect(isInputSchemaPresent(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isInputSchemaPresent(undefined)).toBe(false);
  });

  it("rejects arrays", () => {
    expect(isInputSchemaPresent([])).toBe(false);
    expect(isInputSchemaPresent([{ type: "object" }])).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isInputSchemaPresent("schema")).toBe(false);
    expect(isInputSchemaPresent(42)).toBe(false);
    expect(isInputSchemaPresent(true)).toBe(false);
  });
});
