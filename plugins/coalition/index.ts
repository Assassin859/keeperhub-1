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
      slug: "propose",
      label: "Propose Coalition",
      description:
        "Create a new on-chain coalition with N participants, a stake token, stake amount, and deadline. Returns the coalitionId for downstream nodes.",
      category: "Coalition",
      requiresCredentials: true,
      stepFunction: "proposeStep",
      stepImportPath: "propose",
      outputFields: [
        { field: "success", description: "Whether the proposal succeeded" },
        {
          field: "coalitionId",
          description:
            "ID of the newly created coalition (parsed from the Proposed event)",
        },
        { field: "transactionHash", description: "Transaction hash" },
        { field: "transactionLink", description: "Block explorer link" },
        { field: "gasUsed", description: "Gas cost in wei" },
        { field: "error", description: "Error message if the call failed" },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          showPrivateVariants: true,
          placeholder: "Select network",
          required: true,
        },
        {
          key: "participants",
          label: "Participants",
          type: "template-textarea",
          placeholder: '["0x...", "0x...", "0x..."]',
          rows: 4,
          helpTip:
            "JSON array of EVM addresses (2-20 participants). Each must approve the stakeToken before signing.",
          required: true,
        },
        {
          key: "termsHash",
          label: "Terms Hash",
          type: "template-input",
          placeholder: "0x... (32-byte keccak256 of off-chain terms)",
          example:
            "0xabababababababababababababababababababababababababababababababab",
          required: true,
        },
        {
          key: "deadlineUnix",
          label: "Deadline (Unix timestamp)",
          type: "template-input",
          placeholder: "1800000000 or {{Now.plusDays}}",
          helpTip:
            "Unix seconds. After this time, expire() can refund signers if not all signed.",
          required: true,
        },
        {
          key: "stakeToken",
          label: "Stake Token Address",
          type: "template-input",
          placeholder: "0x... (ERC-20)",
          example: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          required: true,
        },
        {
          key: "stakePerParty",
          label: "Stake Per Party",
          type: "template-input",
          placeholder: "Amount in token's smallest units (e.g. wei)",
          example: "1000000000000000000",
          required: true,
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "gasLimitMultiplier",
              label: "Gas Limit",
              type: "gas-limit-multiplier",
              networkField: "network",
              actionSlug: "propose",
            },
          ],
        },
      ],
    },
    {
      slug: "sign",
      label: "Sign Coalition",
      description:
        "Sign in as a participant and escrow your stake. Auto-approves the stakeToken allowance if needed. Idempotent — safe to retry.",
      category: "Coalition",
      requiresCredentials: true,
      stepFunction: "signStep",
      stepImportPath: "sign",
      outputFields: [
        { field: "success", description: "Whether the sign-in succeeded" },
        {
          field: "transactionHash",
          description: "Sign transaction hash (empty if already signed)",
        },
        { field: "transactionLink", description: "Block explorer link" },
        {
          field: "approvalTransactionHash",
          description:
            "Approval tx hash (only present if allowance was insufficient and skipApproval=No)",
        },
        {
          field: "wasAlreadySigned",
          description:
            "True if the wallet had already signed; the action returned without sending a tx",
        },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          showPrivateVariants: true,
          placeholder: "Select network",
          required: true,
        },
        {
          key: "coalitionId",
          label: "Coalition ID",
          type: "template-input",
          placeholder: "1 or {{Propose.coalitionId}}",
          required: true,
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "skipApproval",
              label: "Skip Auto-Approval",
              type: "select",
              options: [
                { value: "no", label: "No (auto-approve if needed)" },
                { value: "yes", label: "Yes (assume already approved)" },
              ],
              defaultValue: "no",
            },
            {
              key: "gasLimitMultiplier",
              label: "Gas Limit",
              type: "gas-limit-multiplier",
              networkField: "network",
              actionSlug: "sign",
            },
          ],
        },
      ],
    },
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
