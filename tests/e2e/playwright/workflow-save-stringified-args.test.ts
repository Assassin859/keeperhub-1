import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";

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

const WRITE_CONTRACT_ABI = JSON.stringify([
  {
    inputs: [],
    name: "poke",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
]);

type WorkflowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label?: string;
    type: string;
    config: Record<string, unknown>;
  };
};

function triggerNode(): WorkflowNode {
  return {
    id: "trigger",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Manual",
      type: "trigger",
      config: { actionType: "Manual" },
    },
  };
}

function readContractNode(
  overrides: Partial<Record<string, unknown>> = {},
  id = "read-1"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 120 },
    data: {
      label: "Read Contract",
      type: "action",
      config: {
        actionType: "web3/read-contract",
        network: "1",
        contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        abi: READ_CONTRACT_ABI,
        abiFunction: "ilks",
        functionArgs: '["{{@osm-loop:OSM Loop.currentItem.ilkBytes32}}"]',
        ...overrides,
      },
    },
  };
}

function discordNode(id = "notify-1"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 240 },
    data: {
      label: "Discord",
      type: "action",
      config: {
        actionType: "discord/send-message",
        discordMessage: "done",
      },
    },
  };
}

test.describe("KEEP-571: workflow save with stringified container fields", () => {
  test("saves a 3-node workflow with web3/read-contract stringified functionArgs (OSM Alert shape)", async ({
    page,
    apiRequest,
  }) => {
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-read-contract-${Date.now()}`,
      triggerType: "manual",
      nodes: [triggerNode(), readContractNode(), discordNode()],
      edges: [
        { id: "e1", source: "trigger", target: "read-1" },
        { id: "e2", source: "read-1", target: "notify-1" },
      ],
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          nodes: [triggerNode(), readContractNode(), discordNode()],
          edges: [
            { id: "e1", source: "trigger", target: "read-1" },
            { id: "e2", source: "read-1", target: "notify-1" },
          ],
        },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("saves a workflow with legacy `functionName` on web3/write-contract (MegaPoker shape)", async ({
    page,
    apiRequest,
  }) => {
    const writeNode: WorkflowNode = {
      id: "poke-1",
      type: "action",
      position: { x: 0, y: 120 },
      data: {
        label: "Write Contract",
        type: "action",
        config: {
          actionType: "web3/write-contract",
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          functionName: "poke",
          functionArgs: "[]",
        },
      },
    };

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-legacy-fn-name-${Date.now()}`,
      triggerType: "manual",
      nodes: [triggerNode(), writeNode, discordNode()],
      edges: [
        { id: "e1", source: "trigger", target: "poke-1" },
        { id: "e2", source: "poke-1", target: "notify-1" },
      ],
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          nodes: [triggerNode(), writeNode, discordNode()],
          edges: [
            { id: "e1", source: "trigger", target: "poke-1" },
            { id: "e2", source: "poke-1", target: "notify-1" },
          ],
        },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("saves a workflow with an empty-array stringified functionArgs (no-arg function)", async ({
    page,
    apiRequest,
  }) => {
    const noArgWrite: WorkflowNode = {
      id: "poke-1",
      type: "action",
      position: { x: 0, y: 120 },
      data: {
        label: "Write Contract",
        type: "action",
        config: {
          actionType: "web3/write-contract",
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          abiFunction: "poke",
          functionArgs: "[]",
        },
      },
    };

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-empty-args-${Date.now()}`,
      triggerType: "manual",
      nodes: [triggerNode(), noArgWrite, discordNode()],
      edges: [
        { id: "e1", source: "trigger", target: "poke-1" },
        { id: "e2", source: "poke-1", target: "notify-1" },
      ],
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          nodes: [triggerNode(), noArgWrite, discordNode()],
          edges: [
            { id: "e1", source: "trigger", target: "poke-1" },
            { id: "e2", source: "poke-1", target: "notify-1" },
          ],
        },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("rejects a non-JSON, non-template literal in functionArgs with 422 INVALID_ACTION_CONFIG", async ({
    page,
    apiRequest,
  }) => {
    const badNode = readContractNode({
      functionArgs: "this-is-not-json-or-a-template",
    });

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-bad-args-${Date.now()}`,
      triggerType: "manual",
      nodes: [triggerNode(), readContractNode(), discordNode()],
      edges: [
        { id: "e1", source: "trigger", target: "read-1" },
        { id: "e2", source: "read-1", target: "notify-1" },
      ],
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          nodes: [triggerNode(), badNode, discordNode()],
          edges: [
            { id: "e1", source: "trigger", target: "read-1" },
            { id: "e2", source: "read-1", target: "notify-1" },
          ],
        },
      });

      expect(response.status()).toBe(422);
      const body = await response.json();
      expect(body.error).toBe("INVALID_ACTION_CONFIG");
      expect(body.invalidFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "INVALID_FIELD_TYPE",
            field: "functionArgs",
          }),
        ])
      );
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("saves the exact OSM Alert prod node shape that was failing (ooiuqkddnj6fnssg93kgr)", async ({
    page,
    apiRequest,
  }) => {
    const osmAlertNode: WorkflowNode = {
      id: "node-6",
      type: "action",
      position: { x: 0, y: 120 },
      data: {
        label: "Read Vat ilks",
        type: "action",
        config: {
          actionType: "web3/read-contract",
          abi: '[{"inputs":[{"internalType":"bytes32","name":"ilk","type":"bytes32"}],"name":"ilks","outputs":[{"internalType":"uint256","name":"Art","type":"uint256"},{"internalType":"uint256","name":"rate","type":"uint256"},{"internalType":"uint256","name":"spot","type":"uint256"},{"internalType":"uint256","name":"line","type":"uint256"},{"internalType":"uint256","name":"dust","type":"uint256"}],"stateMutability":"view","type":"function"}]',
          network: "1",
          abiFunction: "ilks",
          functionArgs: '["{{@osm-loop:OSM Loop.currentItem.ilkBytes32}}"]',
          contractAddress: "{{@fetch-chainlog:Fetch Chainlog.data.MCD_VAT}}",
        },
      },
    };

    const nodes = [triggerNode(), osmAlertNode, discordNode("notify-1")];
    const edges = [
      { id: "e1", source: "trigger", target: "node-6" },
      { id: "e2", source: "node-6", target: "notify-1" },
    ];

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-osm-alert-${Date.now()}`,
      triggerType: "manual",
      nodes,
      edges,
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { nodes, edges },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });
});
