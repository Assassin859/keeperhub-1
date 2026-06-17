/**
 * Factory tests for the deterministic workflow factory (52-03).
 *
 * Requirements covered: PREFILL-01..07 + HF condition coercion (SC#1)
 * Wave 0 scaffold; Wave 2 (52-03) implementation turns all tests GREEN.
 */
import { describe, expect, it } from "vitest";
import {
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import { buildWorkflow } from "@/lib/scan/factory";
import type { PrefillWorkflow } from "@/lib/scan/factory/types";
import {
  validateNoMaxUint256Approval,
  validateTemplateRefs,
} from "@/lib/scan/factory/validate";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Top-level regex constants (useTopLevelRegex rule)
// ---------------------------------------------------------------------------

const RE_WRITE_ACTION = /write-contract|protocol-write/;
const RE_HF_1E18 = /^\d{19}$/;

// ---------------------------------------------------------------------------
// ConditionConfig inline type (avoids `as any` for dynamic conditionConfig)
// ---------------------------------------------------------------------------

type ConditionGroup = {
  rules?: Array<{ rightOperand?: unknown; operator?: string }>;
};
type ConditionConfig = { group?: ConditionGroup } | undefined;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

const HEALTH_DESCRIPTOR: SuggestionDescriptor = {
  id: "hf-monitor-aave-v3-42161",
  name: "Aave V3 Health Factor Alert",
  description:
    "Monitor HF (currently 1.80) on Arbitrum. Alert when HF drops below 1.5.",
  category: "health",
  chainId: 42_161,
  readOrWrite: "read",
  protocol: "aave-v3",
  usdValue: 5000,
  riskNote:
    "Read-only monitoring. This workflow does not make any transactions.",
  confirmInputs: {
    walletAddress: "Your wallet address to monitor",
    threshold: "Alert threshold (default: 1.5, floor: 1.3)",
  },
};

const YIELD_DESCRIPTOR: SuggestionDescriptor = {
  id: "yield-monitor-usdc-42161",
  name: "Arbitrum USDC Idle Yield Monitor",
  description: "Monitor 500 USDC on Arbitrum for yield opportunities.",
  category: "yield",
  chainId: 42_161,
  readOrWrite: "read",
  protocol: undefined,
  usdValue: 500,
  riskNote:
    "Read-only monitoring. This workflow does not make any transactions.",
  confirmInputs: {
    walletAddress: "Your wallet address to monitor",
  },
};

// A node that would trigger the MaxUint256 validator
const MAX_UINT256_STR =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const APPROVE_NODE_MAX: WorkflowNode = {
  id: "bad-approve",
  type: "action",
  position: { x: 100, y: 200 },
  data: {
    type: "action",
    label: "Approve Token (Unlimited)",
    config: {
      actionType: "web3/approve-token",
      network: "42161",
      amount: "max",
      tokenAddress: ARBITRUM_USDC,
    },
    status: "idle",
  },
};

const APPROVE_NODE_EXACT: WorkflowNode = {
  id: "good-approve",
  type: "action",
  position: { x: 100, y: 200 },
  data: {
    type: "action",
    label: "Approve Token (Exact)",
    config: {
      actionType: "web3/approve-token",
      network: "42161",
      amount: "1000000",
      tokenAddress: ARBITRUM_USDC,
    },
    status: "idle",
  },
};

// ---------------------------------------------------------------------------
// PREFILL-01: Factory output matches WorkflowNode/WorkflowEdge canvas shape
// ---------------------------------------------------------------------------

describe("PREFILL-01: factory returns PrefillWorkflow with canvas-compatible shape", () => {
  it("buildWorkflow is a function", () => {
    expect(typeof buildWorkflow).toBe("function");
  });

  it("health: buildWorkflow(healthDescriptor) returns an object with nodes and edges arrays", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it("health: workflowType is 'read' on all factory output", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    expect(result.workflowType).toBe("read");
  });

  it("health: every node has required canvas fields (id, type, position, data)", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    for (const node of result.nodes) {
      expect(typeof node.id).toBe("string");
      expect(["trigger", "action"]).toContain(node.type);
      expect(typeof node.position.x).toBe("number");
      expect(typeof node.position.y).toBe("number");
      expect(typeof node.data.label).toBe("string");
      expect(["trigger", "action", "add"]).toContain(node.data.type);
    }
  });

  it("health: every edge has id, source, target, and type 'default'", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    for (const edge of result.edges) {
      expect(typeof edge.id).toBe("string");
      expect(typeof edge.source).toBe("string");
      expect(typeof edge.target).toBe("string");
      expect(edge.type).toBe("default");
    }
  });

  it("health: actionType lives at data.config.actionType, not data.actionType (KEEP-571 wire-shape)", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const actionNodes = result.nodes.filter((n) => n.data.type === "action");
    for (const node of actionNodes) {
      // actionType must be inside data.config, not at the legacy data level
      expect((node.data as Record<string, unknown>).actionType).toBeUndefined();
      expect(node.data.config?.actionType).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// PREFILL-03: Deterministic IDs; every template ref resolves
// ---------------------------------------------------------------------------

describe("PREFILL-03: template ref validation", () => {
  it("template ref: validateTemplateRefs is a function", () => {
    expect(typeof validateTemplateRefs).toBe("function");
  });

  it("template ref: factory output passes validateTemplateRefs (all refs resolve)", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const { valid, errors } = validateTemplateRefs(result.nodes, result.edges);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("template ref: node IDs are deterministic (same descriptor → same IDs)", () => {
    const a: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const b: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const aIds = a.nodes.map((n) => n.id).sort();
    const bIds = b.nodes.map((n) => n.id).sort();
    expect(aIds).toEqual(bIds);
  });
});

// ---------------------------------------------------------------------------
// PREFILL-04: chainId injected into config.network as a string
// ---------------------------------------------------------------------------

describe("PREFILL-04: chainId wired into config.network", () => {
  it("network: all web3 nodes in health workflow have config.network === '42161'", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const web3Nodes = result.nodes.filter(
      (n) => n.data.config?.network !== undefined
    );
    expect(web3Nodes.length).toBeGreaterThan(0);
    for (const node of web3Nodes) {
      expect(node.data.config?.network).toBe("42161");
    }
  });

  it("network: config.network is always a string, not a number", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const web3Nodes = result.nodes.filter(
      (n) => n.data.config?.network !== undefined
    );
    for (const node of web3Nodes) {
      expect(typeof node.data.config?.network).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// PREFILL-05: Schedule interval floor (>= 60s) and per-category defaults
// ---------------------------------------------------------------------------

describe("PREFILL-05: schedule floor and cron defaults", () => {
  it("interval: trigger node uses scheduleCron key (not 'cron')", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleCron).toBeDefined();
    expect(trigger?.data.config?.cron).toBeUndefined();
  });

  it("interval: trigger node uses scheduleTimezone key (not 'timezone')", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleTimezone).toBeDefined();
    expect(trigger?.data.config?.timezone).toBeUndefined();
  });

  it("interval: health workflow cron is every 5 minutes (*/5 * * * *)", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const trigger = result.nodes.find((n) => n.data.type === "trigger");
    expect(trigger?.data.config?.scheduleCron).toBe("*/5 * * * *");
  });
});

// ---------------------------------------------------------------------------
// PREFILL-06: workflowType "read" passes read-only guard
// ---------------------------------------------------------------------------

describe("PREFILL-06: read-only guard", () => {
  it("read-only: health workflow has workflowType 'read'", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    expect(result.workflowType).toBe("read");
  });

  it("read-only: no node in health workflow has a write-type actionType", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    for (const node of result.nodes) {
      const actionType = String(node.data.config?.actionType ?? "");
      expect(actionType).not.toMatch(RE_WRITE_ACTION);
    }
  });
});

// ---------------------------------------------------------------------------
// PREFILL-07: MaxUint256 approval validator
// ---------------------------------------------------------------------------

describe("PREFILL-07: MaxUint256 approval blocked", () => {
  it("MaxUint256: validateNoMaxUint256Approval is a function", () => {
    expect(typeof validateNoMaxUint256Approval).toBe("function");
  });

  it("MaxUint256: node with amount 'max' is rejected", () => {
    const { valid, errors } = validateNoMaxUint256Approval([APPROVE_NODE_MAX]);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("MaxUint256: node with numeric MaxUint256 string is rejected", () => {
    const numericMaxNode: WorkflowNode = {
      ...APPROVE_NODE_MAX,
      id: "numeric-max",
      data: {
        ...APPROVE_NODE_MAX.data,
        config: {
          ...APPROVE_NODE_MAX.data.config,
          amount: MAX_UINT256_STR,
        },
      },
    };
    const { valid } = validateNoMaxUint256Approval([numericMaxNode]);
    expect(valid).toBe(false);
  });

  it("MaxUint256: node with exact amount is accepted", () => {
    const { valid, errors } = validateNoMaxUint256Approval([
      APPROVE_NODE_EXACT,
    ]);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it("MaxUint256: factory health workflow passes the MaxUint256 check", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const { valid } = validateNoMaxUint256Approval(result.nodes);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC#1: HF condition evaluates correctly with bigint-string comparison
// ---------------------------------------------------------------------------

describe("condition evaluates: HF condition coercion (SC#1)", () => {
  it("condition evaluates: HF monitor condition node carries rightOperand as 1e18-scaled string", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    expect(condNode).toBeDefined();
    const condConfig = condNode?.data.config
      ?.conditionConfig as ConditionConfig;
    const rules = condConfig?.group?.rules ?? [];
    expect(rules.length).toBeGreaterThan(0);
    // rightOperand should be a 1e18-scaled integer string, e.g. "1500000000000000000"
    const rightOperand = String(rules[0].rightOperand);
    expect(rightOperand).toMatch(RE_HF_1E18);
  });

  it("condition evaluates: condition node uses operator '<' not 'less_than'", () => {
    const result: PrefillWorkflow = buildWorkflow(HEALTH_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    const condConfig2 = condNode?.data.config
      ?.conditionConfig as ConditionConfig;
    const rules = condConfig2?.group?.rules ?? [];
    expect(rules[0].operator).toBe("<");
  });
});

// ---------------------------------------------------------------------------
// Task 3 (52-03): stablecoin yield shape + read-only guard conformance
// ---------------------------------------------------------------------------

describe("PREFILL-06 Task 3: yield workflow passes validateWorkflow read-only guard", () => {
  it("read-only: validateWorkflow(workflowType:'read') returns zero errors and zero warnings", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const validatorInput: ValidatorWorkflow = {
      id: "factory-test-yield",
      nodes: result.nodes,
      edges: result.edges,
      inputSchema: null,
      outputMapping: null,
      isListed: false,
      workflowType: "read",
    };
    const validation = validateWorkflow(validatorInput);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });

  it("read-only: no yield node has a write-type actionType", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    for (const node of result.nodes) {
      const actionType = String(node.data.config?.actionType ?? "");
      expect(actionType).not.toMatch(RE_WRITE_ACTION);
    }
  });
});

describe("PREFILL-01 Task 3: yield shape conforms to canvas wire-shape", () => {
  it("shape: every node satisfies node.type === node.data.type", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    for (const node of result.nodes) {
      expect(node.type).toBe(node.data.type);
    }
  });

  it("shape: all edges have type 'default'", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    for (const edge of result.edges) {
      expect(edge.type).toBe("default");
    }
  });

  it("shape: yield workflow has 4 nodes and 3 edges", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);
  });

  it("shape: condition→alert edge on yield shape carries sourceHandle 'true'", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const condNode = result.nodes.find(
      (n) => String(n.data.config?.actionType) === "Condition"
    );
    expect(condNode).toBeDefined();
    const condEdge = result.edges.find((e) => e.source === condNode?.id);
    expect(condEdge?.sourceHandle).toBe("true");
  });
});

describe("PREFILL-03 Task 3: yield shape template refs all resolve", () => {
  it("template ref: validateTemplateRefs on yield output returns valid:true", () => {
    const result: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const { valid, errors } = validateTemplateRefs(result.nodes, result.edges);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("template ref: yield node IDs are deterministic (same descriptor → same IDs)", () => {
    const a: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const b: PrefillWorkflow = buildWorkflow(YIELD_DESCRIPTOR);
    const aIds = a.nodes.map((n) => n.id).sort();
    const bIds = b.nodes.map((n) => n.id).sort();
    expect(aIds).toEqual(bIds);
  });
});
