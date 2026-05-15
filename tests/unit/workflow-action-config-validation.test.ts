import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  it("accepts the valid workflow import fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "fixtures/workflow-import-valid.json"),
        "utf8"
      )
    ) as { nodes: Parameters<typeof validateWorkflowActionConfigs>[0] };

    expect(validateWorkflowActionConfigs(fixture.nodes)).toEqual({
      valid: true,
      issues: [],
    });
  });

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

  it("allows template values in typed protocol fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("aave-v3/supply", {
        network: "1",
        asset: "{{trigger.walletAddress}}",
        amount: "{{@node-1:Previous.amount}}",
        onBehalfOf: "{{@node-1:Previous.recipient}}",
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("rejects invalid literal values in typed protocol address fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("aave-v3/supply", {
        network: "1",
        asset: "not-an-address",
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

  it("allows template values in isAddressField template-input fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("chainlink/ccip-check-bridge-allowance", {
        network: "1",
        contractAddress: "{{trigger.tokenAddress}}",
        owner: "{{trigger.walletAddress}}",
        spender: "{{@node-1:Previous.router}}",
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("rejects non-address non-template literals in isAddressField fields", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("chainlink/ccip-check-bridge-allowance", {
        network: "1",
        contractAddress: "not-an-address",
        owner: "{{trigger.walletAddress}}",
        spender: "{{@node-1:Previous.router}}",
      }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[0].data.config.contractAddress",
          field: "contractAddress",
          expected: "address",
        }),
      ])
    );
  });

  it("accepts JSON-string tuple array protocol fields from the editor", () => {
    const result = validateWorkflowActionConfigs([
      actionNode("chainlink/ccip-send", {
        network: "8453",
        destinationChainSelector: "16015286601757825753",
        receiver: "0x0000000000000000000000000000000000000001",
        data: "0x",
        tokenAmounts:
          '[{"token":"0x0000000000000000000000000000000000000002","amount":"1"}]',
        feeToken: "0x0000000000000000000000000000000000000000",
        extraArgs: "0x",
      }),
    ]);

    expect(result).toEqual({ valid: true, issues: [] });
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

  describe("KEEP-571 stringified container fields (UI wire format)", () => {
    const READ_CONTRACT_ABI = JSON.stringify([
      {
        inputs: [{ internalType: "bytes32", name: "ilk", type: "bytes32" }],
        name: "ilks",
        outputs: [
          { internalType: "uint256", name: "Art", type: "uint256" },
          { internalType: "uint256", name: "rate", type: "uint256" },
        ],
        stateMutability: "view",
        type: "function",
      },
    ]);

    it("accepts a JSON-stringified functionArgs array (the format the UI emits)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          functionArgs: '["{{@osm-loop:OSM Loop.currentItem.ilkBytes32}}"]',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts an empty-array functionArgs string (no-arg function)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: JSON.stringify([
            {
              inputs: [],
              name: "poke",
              outputs: [],
              stateMutability: "nonpayable",
              type: "function",
            },
          ]),
          abiFunction: "poke",
          functionArgs: "[]",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts an empty-string functionArgs (form initial state)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          functionArgs: "",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a native array functionArgs (imported / hand-edited)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          functionArgs: [
            "0x0000000000000000000000000000000000000000000000000000000000000001",
          ],
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a template-only functionArgs value", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          functionArgs: "{{@previous.argsList}}",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("rejects a non-JSON, non-template literal in functionArgs", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          functionArgs: "not-json",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[0].data.config.functionArgs",
          field: "functionArgs",
          expected: "object or array",
          received: "not-json",
        }),
      ]);
    });

    it("rejects a JSON-stringified scalar in functionArgs (not array/object)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          functionArgs: '"only-a-string"',
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          field: "functionArgs",
        }),
      ]);
    });

    it("accepts a JSON-stringified argsList on batch-read-contract", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "uniform",
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          argsList: '[["0x01"],["0x02"]]',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a JSON-stringified calls list on batch-read-contract (mixed)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "mixed",
          calls:
            '[{"network":"1","contractAddress":"0x6B175474E89094C44Da98b954EedeAC495271d0F","abi":[],"abiFunction":"foo","args":[]}]',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a JSON-stringified object form on a json-editor / object field", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          functionArgs: '{"named":"args"}',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a 3+ node workflow with web3 read-contract using the UI's stringified form", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "trigger",
          type: "trigger",
          data: {
            label: "Trigger",
            type: "trigger",
            config: { actionType: "Manual" },
          },
        },
        actionNode(
          "web3/read-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: READ_CONTRACT_ABI,
            abiFunction: "ilks",
            functionArgs: '["0x0000000000000000000000000000000000000001"]',
          },
          "node-1"
        ),
        actionNode(
          "web3/write-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: JSON.stringify([
              {
                inputs: [],
                name: "poke",
                outputs: [],
                stateMutability: "nonpayable",
                type: "function",
              },
            ]),
            abiFunction: "poke",
            functionArgs: "[]",
          },
          "node-2"
        ),
        actionNode(
          "discord/send-message",
          { discordMessage: "done" },
          "node-3"
        ),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });
  });

  describe("KEEP-571 legacy field aliases", () => {
    const WRITE_CONTRACT_ABI = JSON.stringify([
      {
        inputs: [],
        name: "poke",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
    ]);

    it("accepts legacy functionName on web3/write-contract when abiFunction is absent (MegaPoker case)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          functionName: "poke",
          functionArgs: "[]",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts legacy functionName on web3/read-contract", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: "[]",
          functionName: "balanceOf",
          functionArgs: '["{{trigger.walletAddress}}"]',
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("prefers canonical abiFunction over legacy functionName when both are present", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          abiFunction: "poke",
          functionName: "stale-legacy-value",
          functionArgs: "[]",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("still rejects truly unknown fields even when an alias map exists for the action", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          abiFunction: "poke",
          functionArgs: "[]",
          totallyMadeUpField: "nope",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "UNKNOWN_FIELD",
          field: "totallyMadeUpField",
        }),
      ]);
    });

    it("still flags missing required abiFunction when neither canonical nor legacy alias is set", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/write-contract", {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          functionArgs: "[]",
        }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "abiFunction",
          }),
        ])
      );
    });
  });

  describe("KEEP-571 OSM Alert regression (real prod node shape)", () => {
    it("accepts the exact node shape that prod workflow ooiuqkddnj6fnssg93kgr was failing to save", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/read-contract", {
          abi: '[{"inputs":[{"internalType":"bytes32","name":"ilk","type":"bytes32"}],"name":"ilks","outputs":[{"internalType":"uint256","name":"Art","type":"uint256"},{"internalType":"uint256","name":"rate","type":"uint256"},{"internalType":"uint256","name":"spot","type":"uint256"},{"internalType":"uint256","name":"line","type":"uint256"},{"internalType":"uint256","name":"dust","type":"uint256"}],"stateMutability":"view","type":"function"}]',
          network: "1",
          abiFunction: "ilks",
          functionArgs: '["{{@osm-loop:OSM Loop.currentItem.ilkBytes32}}"]',
          integrationId: "ecw50nj0v9at1p6thn0nh",
          contractAddress: "{{@fetch-chainlog:Fetch Chainlog.data.MCD_VAT}}",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });
  });

  describe("node-count invariance (prove >2 node failures were per-node, not threshold)", () => {
    const READ_CONTRACT_ABI = JSON.stringify([
      {
        inputs: [{ internalType: "bytes32", name: "ilk", type: "bytes32" }],
        name: "ilks",
        outputs: [{ internalType: "uint256", name: "Art", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ]);

    function makeAffectedReadNode(id: string): ReturnType<typeof actionNode> {
      return actionNode(
        "web3/read-contract",
        {
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: READ_CONTRACT_ABI,
          abiFunction: "ilks",
          functionArgs:
            '["0x0000000000000000000000000000000000000000000000000000000000000001"]',
        },
        id
      );
    }

    function makeFillerNode(id: string): ReturnType<typeof actionNode> {
      return actionNode("discord/send-message", { discordMessage: id }, id);
    }

    it.each([
      1, 2, 3, 5, 10, 20,
    ])("a workflow of size %i with the affected node passes", (size) => {
      const nodes: ReturnType<typeof actionNode>[] = [];
      for (let i = 0; i < size; i++) {
        nodes.push(
          i === 0 ? makeAffectedReadNode(`n-${i}`) : makeFillerNode(`n-${i}`)
        );
      }

      const result = validateWorkflowActionConfigs(nodes);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it.each([
      0, 1, 3, 5, 9,
    ])("validation outcome is identical regardless of affected-node index (idx=%i in 10-node workflow)", (affectedIndex) => {
      const nodes: ReturnType<typeof actionNode>[] = [];
      for (let i = 0; i < 10; i++) {
        nodes.push(
          i === affectedIndex
            ? makeAffectedReadNode(`n-${i}`)
            : makeFillerNode(`n-${i}`)
        );
      }

      const result = validateWorkflowActionConfigs(nodes);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("a workflow with N affected nodes still passes (no aggregate cap)", () => {
      const nodes: ReturnType<typeof actionNode>[] = [];
      for (let i = 0; i < 15; i++) {
        nodes.push(makeAffectedReadNode(`n-${i}`));
      }

      const result = validateWorkflowActionConfigs(nodes);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("reports invalid fields at the correct node index in a 6-node workflow", () => {
      const nodes = [
        makeFillerNode("n-0"),
        makeFillerNode("n-1"),
        makeFillerNode("n-2"),
        actionNode(
          "web3/read-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: READ_CONTRACT_ABI,
            abiFunction: "ilks",
            functionArgs: "not-json-not-template",
          },
          "n-3"
        ),
        makeFillerNode("n-4"),
        makeFillerNode("n-5"),
      ];

      const result = validateWorkflowActionConfigs(nodes);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          path: "nodes[3].data.config.functionArgs",
        }),
      ]);
    });

    it("collects issues from multiple affected nodes spread across the array", () => {
      const nodes = [
        actionNode(
          "web3/read-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: READ_CONTRACT_ABI,
            abiFunction: "ilks",
            functionArgs: "bogus-a",
          },
          "n-0"
        ),
        makeFillerNode("n-1"),
        makeFillerNode("n-2"),
        actionNode(
          "web3/read-contract",
          {
            network: "1",
            contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            abi: READ_CONTRACT_ABI,
            abiFunction: "ilks",
            functionArgs: "bogus-b",
          },
          "n-3"
        ),
        makeFillerNode("n-4"),
      ];

      const result = validateWorkflowActionConfigs(nodes);
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0]).toMatchObject({
        path: "nodes[0].data.config.functionArgs",
        received: "bogus-a",
      });
      expect(result.issues[1]).toMatchObject({
        path: "nodes[3].data.config.functionArgs",
        received: "bogus-b",
      });
    });
  });

  describe("broader save-time edge cases (not specific to KEEP-571)", () => {
    it("accepts an empty nodes array (new workflow placeholder)", () => {
      const result = validateWorkflowActionConfigs([]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("skips trigger nodes entirely (validator only gates action nodes)", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "trigger",
          type: "trigger",
          data: {
            type: "trigger",
            config: { actionType: "Manual", anyArbitraryField: 42 },
          },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("skips nodes whose data.config is missing or non-object", () => {
      const result = validateWorkflowActionConfigs([
        { id: "n-0", type: "action", data: { type: "action" } },
        {
          id: "n-1",
          type: "action",
          data: { type: "action", config: null as never },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("skips nodes with missing or blank actionType (incomplete authoring state)", () => {
      const result = validateWorkflowActionConfigs([
        {
          id: "n-0",
          type: "action",
          data: { type: "action", config: { actionType: "" } },
        },
        {
          id: "n-1",
          type: "action",
          data: { type: "action", config: {} },
        },
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("does not flag RESERVED_CONFIG_KEYS (integrationId, actionType, addressBookSelection, usePrivateMempool, strict)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", {
          discordMessage: "hi",
          integrationId: "intg-1",
          usePrivateMempool: true,
          strict: false,
        }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a number for a string-like field (validator coerces stringLike)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", { discordMessage: 12_345 }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("rejects an object for a string-like field", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", {
          discordMessage: { not: "a string" },
        }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          field: "discordMessage",
        }),
      ]);
    });

    it("respects showWhen gating: hidden required field is not flagged missing", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "mixed",
          calls:
            '[{"network":"1","contractAddress":"0x6B175474E89094C44Da98b954EedeAC495271d0F","abi":[],"abiFunction":"foo","args":[]}]',
        }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("flags a missing required field that IS visible under showWhen", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("web3/batch-read-contract", {
          inputMode: "uniform",
        }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "network",
          }),
        ])
      );
    });

    it("validates each node independently: one broken node does not invalidate sibling nodes", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", { discordMessage: "valid" }, "n-0"),
        actionNode(
          "webhook/send-webhook",
          {
            webhookUrl: "https://example.com",
            webhookMethod: "POST",
          },
          "n-1"
        ),
        actionNode("discord/send-message", { Message: "wrong-case" }, "n-2"),
      ]);
      expect(result.valid).toBe(false);
      const paths = result.issues.map((i) => i.path);
      expect(paths.every((p) => p.startsWith("nodes[2]"))).toBe(true);
    });

    it("returns deterministic issue ordering across the node array", () => {
      const nodes: ReturnType<typeof actionNode>[] = [];
      for (let i = 0; i < 5; i++) {
        nodes.push(
          actionNode("discord/send-message", { Message: `bad-${i}` }, `n-${i}`)
        );
      }
      const result = validateWorkflowActionConfigs(nodes);
      const unknownFieldPaths = result.issues
        .filter((i) => i.code === "UNKNOWN_FIELD")
        .map((i) => i.path);
      expect(unknownFieldPaths).toEqual([
        "nodes[0].data.config.Message",
        "nodes[1].data.config.Message",
        "nodes[2].data.config.Message",
        "nodes[3].data.config.Message",
        "nodes[4].data.config.Message",
      ]);
    });

    it("does not double-report the same field as both UNKNOWN_FIELD and INVALID_FIELD_TYPE", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("discord/send-message", { discordMessage: "ok" }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a node that uses an integer-string for a protocol-uint field (chainId-style)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("aave-v3/supply", {
          network: "1",
          asset: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
          onBehalfOf: "0x0000000000000000000000000000000000000002",
        }),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("rejects an empty string for a required string field (treated as missing)", () => {
      const result = validateWorkflowActionConfigs([
        actionNode("webhook/send-webhook", {
          webhookUrl: "",
          webhookMethod: "POST",
        }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "MISSING_REQUIRED_FIELD",
            field: "webhookUrl",
          }),
        ])
      );
    });
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
