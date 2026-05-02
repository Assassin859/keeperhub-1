import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { CoalitionIcon } from "./icon";

const coalitionPlugin: IntegrationPlugin = {
  type: "coalition",
  label: "Coalition",
  description:
    "Multi-party on-chain commitments with stake escrow and slashing. Propose, collect signatures, activate, slash on breach, dissolve cleanly.",
  icon: CoalitionIcon,
  singleConnection: true,
  requiresCredentials: false,
  formFields: [],
  testConfig: {
    getTestFunction: async () => {
      const { testCoalition } = await import("./test");
      return testCoalition;
    },
  },
  actions: [
    {
      slug: "check-status",
      label: "Check Coalition Status",
      description:
        "Read the current state, signed/breached/slashed counts, and participants of a coalition. Use this for polling loops before activate/dissolve.",
      category: "Coalition",
      stepFunction: "checkStatusStep",
      stepImportPath: "check-status",
      outputFields: [
        { field: "success", description: "Whether the read succeeded" },
        {
          field: "state",
          description:
            "Current state label: PROPOSED, ACTIVE, DISSOLVED, SLASHED, or EXPIRED",
        },
        {
          field: "signedCount",
          description: "Number of participants who have signed",
        },
        {
          field: "breachedCount",
          description: "Number of participants marked as breached",
        },
        {
          field: "slashedCount",
          description: "Number of participants whose stake has been slashed",
        },
        {
          field: "totalParticipants",
          description: "Total participants in the coalition",
        },
        {
          field: "ready",
          description:
            "True when state is PROPOSED and all participants have signed (safe to activate)",
        },
        {
          field: "participants",
          description: "Array of participant addresses",
        },
        {
          field: "termsHash",
          description: "32-byte hash of the off-chain terms document",
        },
        {
          field: "deadline",
          description: "Coalition deadline as Unix timestamp string",
        },
        {
          field: "stakeToken",
          description: "ERC-20 token address used for stakes",
        },
        {
          field: "stakePerParty",
          description: "Stake amount per participant in token's smallest units",
        },
        {
          field: "error",
          description: "Error message if the read failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          placeholder: "Select network",
          required: true,
        },
        {
          key: "coalitionId",
          label: "Coalition ID",
          type: "template-input",
          placeholder: "1 or {{Propose.coalitionId}}",
          example: "1",
          required: true,
        },
      ],
    },
  ],
};

registerIntegration(coalitionPlugin);

export default coalitionPlugin;
