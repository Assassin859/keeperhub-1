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
      slug: "activate",
      label: "Activate Coalition",
      description:
        "Transition a fully-signed coalition from PROPOSED to ACTIVE. Idempotent — safe to retry once active.",
      category: "Coalition",
      requiresCredentials: true,
      stepFunction: "activateStep",
      stepImportPath: "activate",
      outputFields: [
        { field: "success", description: "Whether activation succeeded" },
        {
          field: "transactionHash",
          description: "Activate tx hash (empty if already active)",
        },
        { field: "transactionLink", description: "Block explorer link" },
        {
          field: "alreadyActive",
          description: "True if the coalition was already ACTIVE",
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
              key: "gasLimitMultiplier",
              label: "Gas Limit",
              type: "gas-limit-multiplier",
              networkField: "network",
              actionSlug: "activate",
            },
          ],
        },
      ],
    },
    {
      slug: "breach",
      label: "Record Breach",
      description:
        "Record breach evidence against a participant of an active coalition. Pre-validates state, participation, and prior breach status.",
      category: "Coalition",
      requiresCredentials: true,
      stepFunction: "breachStep",
      stepImportPath: "breach",
      outputFields: [
        { field: "success", description: "Whether the breach record succeeded" },
        { field: "transactionHash", description: "Tx hash" },
        { field: "transactionLink", description: "Block explorer link" },
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
          placeholder: "1",
          required: true,
        },
        {
          key: "breachingParty",
          label: "Breaching Party",
          type: "template-input",
          placeholder: "0x...",
          required: true,
        },
        {
          key: "evidenceHash",
          label: "Evidence Hash",
          type: "template-input",
          placeholder: "0x... (32-byte keccak256 of evidence document)",
          required: true,
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "evidenceUri",
              label: "Evidence URI",
              type: "template-input",
              placeholder: "ipfs://... or https://... (logged off-chain only)",
            },
            {
              key: "gasLimitMultiplier",
              label: "Gas Limit",
              type: "gas-limit-multiplier",
              networkField: "network",
              actionSlug: "breach",
            },
          ],
        },
      ],
    },
    {
      slug: "slash",
      label: "Slash Breached Party",
      description:
        "Transfer the breached party's stake pro-rata to non-breached participants. Reliability-tuned: routes through private mempool, supports priority-fee override.",
      category: "Coalition",
      requiresCredentials: true,
      stepFunction: "slashStep",
      stepImportPath: "slash",
      outputFields: [
        { field: "success", description: "Whether the slash succeeded" },
        { field: "transactionHash", description: "Tx hash" },
        { field: "transactionLink", description: "Block explorer link" },
        {
          field: "amountRedistributed",
          description:
            "Total stake redistributed (wei string), parsed from the Slashed event",
        },
        { field: "party", description: "Address of the slashed party" },
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
          placeholder: "1",
          required: true,
        },
        {
          key: "party",
          label: "Party to Slash",
          type: "template-input",
          placeholder: "0x... (must be marked breached)",
          required: true,
        },
        {
          type: "group",
          label: "Reliability",
          defaultExpanded: true,
          fields: [
            {
              key: "usePrivateMempool",
              label: "Use Private Mempool",
              type: "select",
              options: [
                { value: "yes", label: "Yes (recommended for slash)" },
                { value: "no", label: "No (public mempool)" },
              ],
              defaultValue: "yes",
              helpTip:
                "Routes the slash transaction through Flashbots Protect (or the chain's private RPC) to avoid frontrunning.",
            },
            {
              key: "strict",
              label: "Strict Private Mempool",
              type: "select",
              options: [
                { value: "no", label: "No (fall back to public if private RPC unreachable)" },
                { value: "yes", label: "Yes (fail rather than fall back)" },
              ],
              defaultValue: "no",
            },
            {
              key: "priorityFeeGwei",
              label: "Priority Fee Override (gwei)",
              type: "template-input",
              placeholder: "Leave empty for chain default; set 2-5 above baseline for fast inclusion",
            },
          ],
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
              actionSlug: "slash",
            },
          ],
        },
      ],
    },
    {
      slug: "dissolve",
      label: "Dissolve Coalition",
      description:
        "Clean close of an active coalition. Returns each non-breached participant's stake. Restricted to participants.",
      category: "Coalition",
      requiresCredentials: true,
      stepFunction: "dissolveStep",
      stepImportPath: "dissolve",
      outputFields: [
        { field: "success", description: "Whether the dissolve succeeded" },
        { field: "transactionHash", description: "Tx hash" },
        { field: "transactionLink", description: "Block explorer link" },
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
          placeholder: "1",
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
              actionSlug: "dissolve",
            },
          ],
        },
      ],
    },
    {
      slug: "expire",
      label: "Expire Coalition",
      description:
        "Refund signed stakes after the deadline if not all parties signed. Transitions to EXPIRED. Anyone can call.",
      category: "Coalition",
      requiresCredentials: true,
      stepFunction: "expireStep",
      stepImportPath: "expire",
      outputFields: [
        { field: "success", description: "Whether the expire succeeded" },
        { field: "transactionHash", description: "Tx hash" },
        { field: "transactionLink", description: "Block explorer link" },
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
          placeholder: "1",
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
              actionSlug: "expire",
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
