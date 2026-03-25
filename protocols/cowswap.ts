import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: "CoW Swap",
  slug: "cowswap",
  description:
    "CoW Protocol -- batch auction DEX for MEV-protected trades, order pre-signing, and conditional orders",
  website: "https://cow.fi",
  icon: "/protocols/cowswap.png",

  contracts: {
    settlement: {
      label: "GPv2Settlement",
      addresses: {
        // Ethereum Mainnet
        "1": "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
        // Base
        "8453": "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
        // Arbitrum One
        "42161": "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
        // Optimism
        "10": "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
      },
      // Proxy -- ABI auto-resolved via abi-cache
    },
    composableCow: {
      label: "ComposableCoW",
      addresses: {
        // Ethereum Mainnet
        "1": "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
        // Base
        "8453": "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
        // Arbitrum One
        "42161": "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
        // Optimism
        "10": "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
      },
      // ABI auto-resolved via abi-cache
    },
  },

  actions: [
    // --- Settlement reads ---
    {
      slug: "get-domain-separator",
      label: "Get Domain Separator",
      description:
        "Returns the EIP-712 domain separator used to compute order digests for this deployment",
      type: "read",
      contract: "settlement",
      function: "domainSeparator",
      inputs: [],
      outputs: [
        {
          name: "domainSeparator",
          type: "bytes32",
          label: "EIP-712 Domain Separator",
        },
      ],
    },
    {
      slug: "get-vault-relayer",
      label: "Get Vault Relayer",
      description:
        "Returns the GPv2VaultRelayer address that users must approve sell tokens to",
      type: "read",
      contract: "settlement",
      function: "vaultRelayer",
      inputs: [],
      outputs: [
        {
          name: "vaultRelayer",
          type: "address",
          label: "Vault Relayer Address",
        },
      ],
    },
    {
      slug: "get-filled-amount",
      label: "Get Order Fill Amount",
      description:
        "Returns how much of an order has been filled so far in sell token units",
      type: "read",
      contract: "settlement",
      function: "filledAmount",
      inputs: [
        {
          name: "orderUid",
          type: "bytes",
          label: "Order UID (56 bytes)",
        },
      ],
      outputs: [
        {
          name: "filledAmount",
          type: "uint256",
          label: "Filled Amount",
        },
      ],
    },
    {
      slug: "get-pre-signature",
      label: "Get Pre-Signature Status",
      description:
        "Returns the pre-signature status for an order. Non-zero means the order is pre-signed.",
      type: "read",
      contract: "settlement",
      function: "preSignature",
      inputs: [
        {
          name: "orderUid",
          type: "bytes",
          label: "Order UID (56 bytes)",
        },
      ],
      outputs: [
        {
          name: "preSignature",
          type: "uint256",
          label: "Pre-Signature Status",
        },
      ],
    },

    // --- Settlement writes ---
    {
      slug: "set-pre-signature",
      label: "Set Pre-Signature",
      description:
        "Pre-sign an order on-chain for smart contract wallets that cannot sign off-chain",
      type: "write",
      contract: "settlement",
      function: "setPreSignature",
      inputs: [
        {
          name: "orderUid",
          type: "bytes",
          label: "Order UID (56 bytes)",
        },
        {
          name: "signed",
          type: "bool",
          label: "Signed (true to enable, false to cancel)",
        },
      ],
    },
    {
      slug: "invalidate-order",
      label: "Invalidate Order",
      description:
        "Permanently cancel an order on-chain by marking it as fully filled",
      type: "write",
      contract: "settlement",
      function: "invalidateOrder",
      inputs: [
        {
          name: "orderUid",
          type: "bytes",
          label: "Order UID (56 bytes)",
        },
      ],
    },

    // --- ComposableCoW reads ---
    {
      slug: "check-single-order",
      label: "Check Conditional Order",
      description:
        "Returns whether a specific conditional order has been registered by an owner",
      type: "read",
      contract: "composableCow",
      function: "singleOrders",
      inputs: [
        {
          name: "owner",
          type: "address",
          label: "Owner Address",
        },
        {
          name: "orderHash",
          type: "bytes32",
          label: "Order Hash",
        },
      ],
      outputs: [
        {
          name: "exists",
          type: "bool",
          label: "Order Exists",
        },
      ],
    },
    {
      slug: "get-cabinet",
      label: "Get Cabinet Value",
      description:
        "Read conditional order state stored by the order handler in the cabinet key-value store",
      type: "read",
      contract: "composableCow",
      function: "cabinet",
      inputs: [
        {
          name: "owner",
          type: "address",
          label: "Owner Address",
        },
        {
          name: "key",
          type: "bytes32",
          label: "Storage Key",
        },
      ],
      outputs: [
        {
          name: "value",
          type: "bytes32",
          label: "Stored Value",
        },
      ],
    },

    // --- ComposableCoW writes ---
    {
      slug: "remove-conditional-order",
      label: "Remove Conditional Order",
      description:
        "Remove a previously created conditional order to prevent future execution",
      type: "write",
      contract: "composableCow",
      function: "remove",
      inputs: [
        {
          name: "singleOrderHash",
          type: "bytes32",
          label: "Order Hash",
        },
      ],
    },
    {
      slug: "create-conditional-order",
      label: "Create Conditional Order",
      description:
        "Create a programmatic conditional order (TWAP, stop-loss) on ComposableCoW that will be automatically executed when conditions are met",
      type: "write",
      contract: "composableCow",
      function: "create",
      inputs: [
        {
          name: "params",
          type: "bytes",
          label:
            "Conditional Order Params (ABI-encoded ConditionalOrderParams struct)",
        },
        {
          name: "dispatch",
          type: "bool",
          label: "Dispatch (true to emit event for watchtower to pick up)",
        },
      ],
    },
  ],
});
