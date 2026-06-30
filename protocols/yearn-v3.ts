import { defineAbiProtocol } from "@/lib/protocol-registry";
import { erc4626AbiOverrides } from "@/lib/web3/standards/erc4626";
import { native, type ProtocolTestData, wallet } from "@/lib/test-data/types";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      "vault-asset": {},
      "vault-total-assets": {},
      "vault-total-supply": {},
      "vault-balance": { account: wallet() },
      "vault-convert-to-assets": { shares: native("1") },
      "vault-convert-to-shares": { assets: native("1") },
      "vault-preview-deposit": { assets: native("1") },
      "vault-preview-mint": { shares: native("1") },
      "vault-preview-withdraw": { assets: native("1") },
      "vault-preview-redeem": { shares: native("1") },
      "vault-max-deposit": { receiver: wallet() },
      "vault-max-mint": { receiver: wallet() },
      "vault-max-withdraw": { owner: wallet() },
      "vault-max-redeem": { owner: wallet() },
      "get-price-per-share": {},
      "get-total-idle": {},
      "get-total-debt": {},
      "get-is-shutdown": {},
      "get-api-version": {},
      "get-profit-max-unlock-time": {},
      "get-full-profit-unlock-date": {},
      "get-accountant": {},
      "get-deposit-limit": {},
      "get-role-manager": {},
      "get-use-default-queue": {},
      "get-minimum-total-idle": {},
      "get-vault-decimals": {},
    },
    skipped: {
      "vault-deposit": "requires vault asset balance + approval",
      "vault-mint": "requires vault asset balance + approval",
      "vault-withdraw": "requires vault share balance",
      "vault-redeem": "requires vault share balance",
    },
  },
};

// Yearn V3 vaults are EIP-1167 minimal proxies. The ABI cache cannot resolve
// implementation ABIs for clones, so we provide the ABI inline.
// Covers the full ERC-4626 interface plus Yearn-specific view functions
// from VaultV3.vy. snake_case Vyper function names need slug overrides.
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
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
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
    name: "previewMint",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "previewWithdraw",
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
    name: "maxMint",
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
  {
    name: "maxRedeem",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
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
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
]);

export default defineAbiProtocol({
  name: "Yearn V3",
  slug: "yearn",
  description:
    "Yearn V3 yield vaults: fully ERC-4626 compliant yield aggregators with automated strategy management",
  website: "https://yearn.fi",
  icon: "/protocols/yearn.png",

  testData: TEST_DATA,

  contracts: {
    vault: {
      label: "Yearn V3 Vault",
      abi: YEARN_V3_VAULT_ABI,
      userSpecifiedAddress: true,
      addresses: {
        // Ethereum Mainnet (yvUSDC example — actual address is user-specified)
        "1": "0x22028E652a2e937c876F2577f8E78f692d6DAA93",
        // Polygon
        "137": "0xA013Fbd4b711f9ded6fB09C1c0d358E2FbC2EAA0",
        // Arbitrum One
        "42161": "0x6FAF8b7fFeE3306EfcFc2BA9Fec912b4d49834C1",
      },
      overrides: {
        // 18 standard ERC-4626 overrides
        ...erc4626AbiOverrides(),

        // Yearn V3 specific reads
        pricePerShare: {
          slug: "get-price-per-share",
          label: "Price Per Share",
          description:
            "Get the current price per vault share in underlying asset terms",
          outputs: {
            result: { name: "pricePerShare", label: "Price Per Share" },
          },
        },
        totalIdle: {
          slug: "get-total-idle",
          label: "Total Idle Assets",
          description:
            "Get the total amount of underlying assets sitting idle in the vault (not deployed to strategies)",
          outputs: {
            result: { name: "totalIdle", label: "Total Idle Assets" },
          },
        },
        totalDebt: {
          slug: "get-total-debt",
          label: "Total Debt",
          description:
            "Get the total amount of underlying assets deployed to strategies",
          outputs: {
            result: { name: "totalDebt", label: "Total Debt" },
          },
        },
        isShutdown: {
          slug: "get-is-shutdown",
          label: "Is Vault Shutdown",
          description: "Check whether the vault has been shut down",
          outputs: {
            result: { name: "isShutdown", label: "Shutdown Status" },
          },
        },
        apiVersion: {
          slug: "get-api-version",
          label: "API Version",
          description: "Get the Yearn vault API version string",
          outputs: {
            result: { name: "apiVersion", label: "API Version" },
          },
        },
        profitMaxUnlockTime: {
          slug: "get-profit-max-unlock-time",
          label: "Profit Max Unlock Time",
          description:
            "Get the time in seconds over which profits are linearly unlocked",
          outputs: {
            result: { name: "profitMaxUnlockTime", label: "Unlock Duration (seconds)" },
          },
        },
        fullProfitUnlockDate: {
          slug: "get-full-profit-unlock-date",
          label: "Full Profit Unlock Date",
          description:
            "Get the Unix timestamp when all current profits will be fully unlocked",
          outputs: {
            result: { name: "fullProfitUnlockDate", label: "Unlock Timestamp" },
          },
        },
        accountant: {
          slug: "get-accountant",
          label: "Vault Accountant",
          description:
            "Get the address of the vault accountant contract that manages fees and profit reporting",
          outputs: {
            result: { name: "accountant", label: "Accountant Address" },
          },
        },
        deposit_limit: {
          slug: "get-deposit-limit",
          label: "Deposit Limit",
          description:
            "Get the maximum total deposit limit for the vault (0 means deposits are closed)",
          outputs: {
            result: { name: "depositLimit", label: "Deposit Limit" },
          },
        },
        role_manager: {
          slug: "get-role-manager",
          label: "Role Manager",
          description: "Get the address of the vault role manager contract",
          outputs: {
            result: { name: "roleManager", label: "Role Manager Address" },
          },
        },
        use_default_queue: {
          slug: "get-use-default-queue",
          label: "Use Default Queue",
          description:
            "Check whether the vault uses the default withdrawal queue order",
          outputs: {
            result: { name: "useDefaultQueue", label: "Use Default Queue" },
          },
        },
        minimum_total_idle: {
          slug: "get-minimum-total-idle",
          label: "Minimum Total Idle",
          description:
            "Get the minimum amount of underlying assets the vault keeps liquid",
          outputs: {
            result: {
              name: "minimumTotalIdle",
              label: "Minimum Total Idle (wei)",
            },
          },
        },
        decimals: {
          slug: "get-vault-decimals",
          label: "Vault Decimals",
          description: "Get the number of decimals for the vault share token",
          outputs: {
            result: { name: "decimals", label: "Decimals" },
          },
        },
      },
    },
  },
});
