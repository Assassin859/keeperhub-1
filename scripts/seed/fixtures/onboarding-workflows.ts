/**
 * Onboarding workflow fixtures for the getting-started launcher.
 *
 * Six public hub workflows, one per chip in getting-started-config.ts. Each
 * is seeded with a stable `id` and a `listedSlug` matching its chip id so the
 * recommendations endpoint can return the live workflow id by slug.
 *
 * Placeholder values for user-specific fields (wallet addresses, Discord
 * integration) are left as empty strings; the user fills them in after cloning.
 */

import {
  buildActionNode,
  buildConditionNode,
  buildDiscordNode,
  buildEdge,
  buildProtocolMeta,
  buildTriggerNode,
} from "@/lib/workflow/node-builders";

export type OnboardingWorkflowFixture = {
  id: string;
  listedSlug: string;
  name: string;
  description: string;
  featuredProtocol: string;
  nodes: unknown[];
  edges: unknown[];
};

export const ONBOARDING_WORKFLOW_FIXTURES: OnboardingWorkflowFixture[] = [
  {
    id: "onb-aave-health",
    listedSlug: "aave-health",
    name: "Aave Health Factor Monitor",
    description:
      "Check your Aave v3 health factor every hour and send a Discord alert with the current value.",
    featuredProtocol: "aave-v3",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 * * * *",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Get Aave Health Factor",
        "Read the health factor from Aave v3 for the monitored wallet",
        {
          actionType: "aave-v3/get-user-account-data",
          network: "1",
          _protocolMeta: buildProtocolMeta(
            "aave-v3",
            "pool",
            "getUserAccountData",
            "read"
          ),
          user: "",
        },
        400
      ),
      buildDiscordNode(
        "step-2",
        "Aave v3 health factor: {{step-1.healthFactor}}",
        600
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1"), buildEdge("step-1", "step-2")],
  },

  {
    id: "onb-whale-withdrawal",
    listedSlug: "whale-withdrawal",
    name: "Large Withdrawal Alert",
    description:
      "Watch for USDT transfers above 100,000 USDT on mainnet and send a Discord notification.",
    featuredProtocol: "erc20",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Event",
        network: "1",
        contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        eventName: "Transfer",
      }),
      buildConditionNode(
        "step-1",
        {
          condition: "{{@trigger-1:Trigger.value}} > 100000000000",
          group: {
            id: "group-1",
            logic: "AND",
            rules: [
              {
                id: "rule-1",
                leftOperand: "{{@trigger-1:Trigger.value}}",
                operator: ">",
                rightOperand: "100000000000",
              },
            ],
          },
        },
        400
      ),
      buildDiscordNode(
        "step-2",
        "Large USDT transfer detected — from: {{trigger.from}}, to: {{trigger.to}}, value: {{trigger.value}}",
        600
      ),
    ],
    edges: [
      buildEdge("trigger-1", "step-1"),
      buildEdge("step-1", "step-2", "true"),
    ],
  },

  {
    id: "onb-governance",
    listedSlug: "governance",
    name: "Aave Governance Proposal Alert",
    description:
      "Watch for new Aave governance proposals on mainnet and send a Discord notification when one is created.",
    featuredProtocol: "aave-v3",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Event",
        network: "1",
        contractAddress: "0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7",
        eventName: "ProposalCreated",
      }),
      buildDiscordNode(
        "step-1",
        "New Aave governance proposal — id: {{trigger.proposalId}}, proposer: {{trigger.creator}}",
        400
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1")],
  },

  {
    id: "onb-sky-staking",
    listedSlug: "sky-staking",
    name: "SKY Staking Optimizer",
    description:
      "Weekly: approve and deposit USDS into the stUSDS vault to earn staking rewards.",
    featuredProtocol: "sky",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 0 * * 1",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Approve stUSDS to Spend USDS",
        "Approve the stUSDS vault contract to transfer USDS on your behalf",
        {
          actionType: "sky/approve-usds",
          network: "1",
          _protocolMeta: buildProtocolMeta("sky", "usds", "approve", "write"),
          spender: "0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9",
          amount: "1000000000000000000",
        },
        400
      ),
      buildActionNode(
        "step-2",
        "Deposit USDS into stUSDS Vault",
        "Stake USDS into the stUSDS vault and receive stUSDS shares",
        {
          actionType: "sky/st-usds-vault-deposit",
          network: "1",
          _protocolMeta: buildProtocolMeta(
            "sky",
            "stUsds",
            "deposit",
            "write"
          ),
          assets: "1000000000000000000",
          receiver: "",
        },
        600
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1"), buildEdge("step-1", "step-2")],
  },

  {
    id: "onb-steth-wrap",
    listedSlug: "steth-wrap",
    name: "Wrap stETH to wstETH",
    description:
      "Approve and wrap stETH into wstETH to hold a rebasing-protected yield token.",
    featuredProtocol: "lido",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Manual",
      }),
      buildActionNode(
        "step-1",
        "Approve wstETH to Spend stETH",
        "Approve the wstETH contract to transfer stETH on your behalf",
        {
          actionType: "lido/approve-steth",
          network: "1",
          _protocolMeta: buildProtocolMeta("lido", "steth", "approve", "write"),
          spender: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
          amount: "1000000000000000000",
        },
        400
      ),
      buildActionNode(
        "step-2",
        "Wrap stETH into wstETH",
        "Convert stETH to wstETH via the Lido wrapper",
        {
          actionType: "lido/wrap",
          network: "1",
          _protocolMeta: buildProtocolMeta("lido", "wsteth", "wrap", "write"),
          stETHAmount: "1000000000000000000",
        },
        600
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1"), buildEdge("step-1", "step-2")],
  },

  {
    id: "onb-usds-savings",
    listedSlug: "usds-savings",
    name: "USDS Savings Vault Deposit",
    description:
      "Monthly: approve and deposit USDS into the sUSDS savings vault.",
    featuredProtocol: "sky",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 0 1 * *",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Approve sUSDS to Spend USDS",
        "Approve the sUSDS vault contract to transfer USDS on your behalf",
        {
          actionType: "sky/approve-usds",
          network: "1",
          _protocolMeta: buildProtocolMeta("sky", "usds", "approve", "write"),
          spender: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
          amount: "1000000000000000000",
        },
        400
      ),
      buildActionNode(
        "step-2",
        "Deposit USDS into sUSDS Vault",
        "Deposit USDS into the Sky savings vault and receive sUSDS shares",
        {
          actionType: "sky/vault-deposit",
          network: "1",
          _protocolMeta: buildProtocolMeta("sky", "sUsds", "deposit", "write"),
          assets: "1000000000000000000",
          receiver: "",
        },
        600
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1"), buildEdge("step-1", "step-2")],
  },
];
