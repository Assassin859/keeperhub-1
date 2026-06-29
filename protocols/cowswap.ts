import { defineAbiProtocol } from "@/lib/protocol-registry";

// Minimal settlement contract ABI covering all six current actions.
const SETTLEMENT_ABI = JSON.stringify([
  {
    type: "function",
    name: "domainSeparator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "vaultRelayer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "filledAmount",
    stateMutability: "view",
    inputs: [{ name: "orderUid", type: "bytes" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "preSignature",
    stateMutability: "view",
    inputs: [{ name: "orderUid", type: "bytes" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setPreSignature",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderUid", type: "bytes" },
      { name: "signed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "invalidateOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderUid", type: "bytes" }],
    outputs: [],
  },
]);

// Minimal ComposableCoW ABI. The `create` function accepts the
// ConditionalOrderParams struct as a bytes blob (ABI-encoded by the caller)
// to preserve the existing user-facing interface -- the real on-chain function
// takes a named struct; callers must supply the ABI-encoded bytes.
const COMPOSABLE_COW_ABI = JSON.stringify([
  {
    type: "function",
    name: "singleOrders",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "orderHash", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "cabinet",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "key", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "remove",
    stateMutability: "nonpayable",
    inputs: [{ name: "singleOrderHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "create",
    stateMutability: "nonpayable",
    inputs: [
      { name: "params", type: "bytes" },
      { name: "dispatch", type: "bool" },
    ],
    outputs: [],
  },
]);

export default defineAbiProtocol({
  name: "CoW Swap",
  slug: "cowswap",
  description:
    "CoW Protocol: batch auction DEX for MEV-protected trades, order pre-signing, and conditional orders",
  website: "https://cow.fi",
  icon: "/protocols/cowswap.png",

  contracts: {
    settlement: {
      label: "GPv2Settlement",
      abi: SETTLEMENT_ABI,
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
      overrides: {
        domainSeparator: {
          slug: "get-domain-separator",
          label: "Get Domain Separator",
          description:
            "Returns the EIP-712 domain separator used to compute order digests for this deployment",
          outputs: {
            result: { name: "domainSeparator", label: "EIP-712 Domain Separator" },
          },
        },
        vaultRelayer: {
          slug: "get-vault-relayer",
          label: "Get Vault Relayer",
          description:
            "Returns the GPv2VaultRelayer address that users must approve sell tokens to",
          outputs: {
            result: { name: "vaultRelayer", label: "Vault Relayer Address" },
          },
        },
        filledAmount: {
          slug: "get-filled-amount",
          label: "Get Order Fill Amount",
          description:
            "Returns how much of an order has been filled so far in sell token units",
          inputs: {
            orderUid: { label: "Order UID (56 bytes)" },
          },
          outputs: {
            result: { name: "filledAmount", label: "Filled Amount" },
          },
        },
        preSignature: {
          slug: "get-pre-signature",
          label: "Get Pre-Signature Status",
          description:
            "Returns the pre-signature status for an order. Non-zero means the order is pre-signed.",
          inputs: {
            orderUid: { label: "Order UID (56 bytes)" },
          },
          outputs: {
            result: { name: "preSignature", label: "Pre-Signature Status" },
          },
        },
        setPreSignature: {
          slug: "set-pre-signature",
          label: "Set Pre-Signature",
          description:
            "Pre-sign an order on-chain for smart contract wallets that cannot sign off-chain",
          inputs: {
            orderUid: { label: "Order UID (56 bytes)" },
            signed: { label: "Signed (true to enable, false to cancel)" },
          },
        },
        invalidateOrder: {
          slug: "invalidate-order",
          label: "Invalidate Order",
          description:
            "Permanently cancel an order on-chain by marking it as fully filled",
          inputs: {
            orderUid: { label: "Order UID (56 bytes)" },
          },
        },
      },
    },
    composableCow: {
      label: "ComposableCoW",
      abi: COMPOSABLE_COW_ABI,
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
      overrides: {
        singleOrders: {
          slug: "check-single-order",
          label: "Check Conditional Order",
          description:
            "Returns whether a specific conditional order has been registered by an owner",
          inputs: {
            owner: { label: "Owner Address" },
            orderHash: { label: "Order Hash" },
          },
          outputs: {
            result: { name: "exists", label: "Order Exists" },
          },
        },
        cabinet: {
          slug: "get-cabinet",
          label: "Get Cabinet Value",
          description:
            "Read conditional order state stored by the order handler in the cabinet key-value store",
          inputs: {
            owner: { label: "Owner Address" },
            key: { label: "Storage Key" },
          },
          outputs: {
            result: { name: "value", label: "Stored Value" },
          },
        },
        remove: {
          slug: "remove-conditional-order",
          label: "Remove Conditional Order",
          description:
            "Remove a previously created conditional order to prevent future execution",
          inputs: {
            singleOrderHash: { label: "Order Hash" },
          },
        },
        create: {
          slug: "create-conditional-order",
          label: "Create Conditional Order",
          description:
            "Create a programmatic conditional order (TWAP, stop-loss) on ComposableCoW that will be automatically executed when conditions are met",
          inputs: {
            params: {
              label:
                "Conditional Order Params (ABI-encoded ConditionalOrderParams struct)",
            },
            dispatch: {
              label: "Dispatch (true to emit event for watchtower to pick up)",
            },
          },
        },
      },
    },
  },
});
