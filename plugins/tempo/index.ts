import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { TempoIcon } from "./icon";

// Tempo networks: mainnet 4217, Moderato testnet 42431. Both are stablecoin
// EVM chains with no native gas token, so every network picker on this plugin
// is pinned to just these two.
const TEMPO_CHAIN_IDS = ["4217", "42431"];

const tempoPlugin: IntegrationPlugin = {
  type: "tempo",
  egress: "fixed-host",
  label: "Tempo",
  description:
    "Send stablecoin payments on Tempo with on-chain memos and atomic batch payouts, using your KeeperHub wallet",

  icon: TempoIcon,

  // One wallet per organization; write actions check for the wallet at
  // execution time.
  singleConnection: true,
  requiresCredentials: false,
  formFields: [],

  actions: [
    {
      slug: "transfer-with-memo",
      label: "Transfer with Memo",
      description:
        "Send a TIP-20 stablecoin payment on Tempo carrying an on-chain bytes32 memo (e.g. an invoice or pay-run reference)",
      category: "Tempo",
      requiresCredentials: true,
      stepFunction: "transferWithMemoStep",
      stepImportPath: "transfer-with-memo",
      outputFields: [
        { field: "success", description: "Whether the transfer succeeded" },
        {
          field: "transactionHash",
          description: "The transaction hash of the transfer",
        },
        {
          field: "transactionLink",
          description: "Explorer link to view the transaction",
        },
        { field: "from", description: "The sending wallet address" },
        { field: "to", description: "The recipient address" },
        {
          field: "amount",
          description: "The amount transferred (human-readable)",
        },
        {
          field: "memo",
          description: "The bytes32 memo attached to the transfer",
        },
        { field: "chainId", description: "The Tempo chain id used" },
        {
          field: "error",
          description: "Error message if the transfer failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          allowedChainIds: TEMPO_CHAIN_IDS,
          placeholder: "Select a Tempo network",
          required: true,
        },
        {
          key: "tokenConfig",
          label: "Token",
          type: "token-select",
          networkField: "network",
          required: true,
        },
        {
          key: "amount",
          label: "Amount",
          type: "template-input",
          placeholder: "100.50 or {{NodeName.amount}}",
          example: "100.50",
          required: true,
        },
        {
          key: "recipientAddress",
          label: "Recipient Address",
          type: "template-input",
          placeholder: "0x... or {{NodeName.address}}",
          example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
          required: true,
        },
        {
          key: "memo",
          label: "Memo",
          type: "template-input",
          placeholder: "INV-1042 or 0x... (32-byte hex)",
          helpTip:
            "Attached on-chain as an indexed bytes32 topic. Plain text (<= 31 bytes) is utf8-encoded; a 0x + 64-hex value is used verbatim (e.g. a receipt hash).",
        },
      ],
    },
    {
      slug: "batch-payout",
      label: "Batch Payout",
      description:
        "Pay many recipients in one atomic Tempo transaction, each payment stamped with its own memo. All payments settle together or none do.",
      category: "Tempo",
      requiresCredentials: true,
      stepFunction: "batchPayoutStep",
      stepImportPath: "batch-payout",
      outputFields: [
        { field: "success", description: "Whether the batch payout succeeded" },
        {
          field: "transactionHash",
          description: "The transaction hash of the atomic batch",
        },
        {
          field: "transactionLink",
          description: "Explorer link to view the transaction",
        },
        { field: "from", description: "The sending wallet address" },
        {
          field: "payoutCount",
          description: "Number of payments included in the batch",
        },
        {
          field: "totalAmount",
          description: "Total amount paid across the batch (human-readable)",
        },
        { field: "chainId", description: "The Tempo chain id used" },
        {
          field: "error",
          description: "Error message if the batch payout failed",
        },
      ],
      configFields: [
        {
          key: "network",
          label: "Network",
          type: "chain-select",
          chainTypeFilter: "evm",
          allowedChainIds: TEMPO_CHAIN_IDS,
          placeholder: "Select a Tempo network",
          required: true,
        },
        {
          key: "tokenConfig",
          label: "Token",
          type: "token-select",
          networkField: "network",
          required: true,
        },
        {
          key: "payouts",
          label: "Payouts",
          type: "template-textarea",
          placeholder:
            '[{"recipient":"0x...","amount":"100.50","memo":"INV-1042"}] or {{NodeName.payouts}}',
          helpTip:
            'JSON array of payments. Each entry needs "recipient" and "amount"; "memo" is optional and falls back to the shared memo below.',
          rows: 6,
          required: true,
        },
        {
          key: "memo",
          label: "Shared Memo",
          type: "template-input",
          placeholder: "PAYRUN-2026-07 or {{NodeName.payRunId}}",
          helpTip:
            "Applied to every payment that does not set its own memo (e.g. a pay-run id).",
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(tempoPlugin);

export default tempoPlugin;
