import { defineProtocol } from "@/lib/protocol-registry";
import { erc4626VaultActions } from "@/lib/web3/standards/erc4626";

// Yearn V3 vaults are EIP-1167 minimal proxies. The ABI cache cannot resolve
// implementation ABIs for clones, so we provide the ABI inline. This covers
// the full ERC-4626 interface plus Yearn-specific view functions from VaultV3.vy.
const YEARN_V3_VAULT_ABI = JSON.stringify([
  // ERC-4626 write functions
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  // ERC-4626 read functions
  {
    name: "asset",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "convertToShares",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "previewDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "previewRedeem",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "maxDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "maxWithdraw",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // ERC-20 metadata
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  // Yearn V3 specific view functions
  {
    name: "pricePerShare",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalIdle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalDebt",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isShutdown",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "apiVersion",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "profitMaxUnlockTime",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "fullProfitUnlockDate",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "accountant",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "deposit_limit",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "role_manager",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "use_default_queue",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "minimum_total_idle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

export default defineProtocol({
  name: "Yearn V3",
  slug: "yearn",
  description:
    "Yearn V3 yield vaults: fully ERC-4626 compliant yield aggregators with automated strategy management",
  website: "https://yearn.fi",
  icon: "/protocols/yearn.png",

  contracts: {
    vault: {
      label: "Yearn V3 Vault",
      userSpecifiedAddress: true,
      // Reference addresses for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field,
      // since each vault (yvUSDC, yvDAI, yvWETH, etc.) is a separate contract.
      addresses: {
        // Ethereum Mainnet
        "1": "0x22028E652a2e937c876F2577f8E78f692d6DAA93",
        // Polygon
        "137": "0xA013Fbd4b711f9ded6fB09C1c0d358E2FbC2EAA0",
        // Arbitrum One
        "42161": "0x6FAF8b7fFeE3306EfcFc2BA9Fec912b4d49834C1",
      },
      abi: YEARN_V3_VAULT_ABI,
    },
  },

  actions: [
    // 13 standard ERC-4626 vault actions (deposit, withdraw, redeem + 10 reads)
    ...erc4626VaultActions("vault"),

    // Yearn V3 specific read actions

    {
      slug: "get-price-per-share",
      label: "Price Per Share",
      description:
        "Get the current price per vault share in underlying asset terms",
      type: "read",
      contract: "vault",
      function: "pricePerShare",
      inputs: [],
      outputs: [
        {
          name: "pricePerShare",
          type: "uint256",
          label: "Price Per Share",
        },
      ],
    },
    {
      slug: "get-total-idle",
      label: "Total Idle Assets",
      description:
        "Get the total amount of underlying assets sitting idle in the vault (not deployed to strategies)",
      type: "read",
      contract: "vault",
      function: "totalIdle",
      inputs: [],
      outputs: [
        {
          name: "totalIdle",
          type: "uint256",
          label: "Total Idle Assets",
        },
      ],
    },
    {
      slug: "get-total-debt",
      label: "Total Debt",
      description:
        "Get the total amount of underlying assets deployed to strategies",
      type: "read",
      contract: "vault",
      function: "totalDebt",
      inputs: [],
      outputs: [
        {
          name: "totalDebt",
          type: "uint256",
          label: "Total Debt",
        },
      ],
    },
    {
      slug: "get-is-shutdown",
      label: "Is Vault Shutdown",
      description: "Check whether the vault has been shut down",
      type: "read",
      contract: "vault",
      function: "isShutdown",
      inputs: [],
      outputs: [
        {
          name: "isShutdown",
          type: "bool",
          label: "Shutdown Status",
        },
      ],
    },
    {
      slug: "get-api-version",
      label: "API Version",
      description: "Get the Yearn vault API version string",
      type: "read",
      contract: "vault",
      function: "apiVersion",
      inputs: [],
      outputs: [
        {
          name: "apiVersion",
          type: "string",
          label: "API Version",
        },
      ],
    },
    {
      slug: "get-profit-max-unlock-time",
      label: "Profit Max Unlock Time",
      description:
        "Get the time in seconds over which profits are linearly unlocked",
      type: "read",
      contract: "vault",
      function: "profitMaxUnlockTime",
      inputs: [],
      outputs: [
        {
          name: "profitMaxUnlockTime",
          type: "uint256",
          label: "Unlock Duration (seconds)",
        },
      ],
    },
    {
      slug: "get-full-profit-unlock-date",
      label: "Full Profit Unlock Date",
      description:
        "Get the Unix timestamp when all current profits will be fully unlocked",
      type: "read",
      contract: "vault",
      function: "fullProfitUnlockDate",
      inputs: [],
      outputs: [
        {
          name: "fullProfitUnlockDate",
          type: "uint256",
          label: "Unlock Timestamp",
        },
      ],
    },
    {
      slug: "get-accountant",
      label: "Vault Accountant",
      description:
        "Get the address of the vault accountant contract that manages fees and profit reporting",
      type: "read",
      contract: "vault",
      function: "accountant",
      inputs: [],
      outputs: [
        {
          name: "accountant",
          type: "address",
          label: "Accountant Address",
        },
      ],
    },
    {
      slug: "get-deposit-limit",
      label: "Deposit Limit",
      description:
        "Get the maximum total deposit limit for the vault (0 means deposits are closed)",
      type: "read",
      contract: "vault",
      function: "deposit_limit",
      inputs: [],
      outputs: [
        {
          name: "depositLimit",
          type: "uint256",
          label: "Deposit Limit",
        },
      ],
    },
  ],
});
