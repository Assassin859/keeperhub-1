import { defineAbiProtocol } from "@/lib/protocol-registry";
import { erc4626AbiOverrides } from "@/lib/web3/standards/erc4626";
import { wallet, native } from "@/lib/test-data/types";
import sUsdeAbi from "./abis/ethena-susde.json";

const SUSDE_ALLOWED = new Set<string>([
  "asset", "totalAssets", "totalSupply", "balanceOf", "convertToShares", "convertToAssets",
  "previewDeposit", "previewMint", "previewWithdraw", "previewRedeem",
  "maxDeposit", "maxMint", "maxWithdraw", "maxRedeem",
  "deposit", "mint", "withdraw", "redeem",
  "cooldownAssets", "cooldownShares", "cooldownDuration", "cooldowns", "unstake",
]);
const SUSDE_ABI = JSON.stringify(sUsdeAbi.filter((fn) => SUSDE_ALLOWED.has(fn.name)));

const ERC20_MINIMAL_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

const ERC20_BALANCE_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

export default defineAbiProtocol({
  name: "Ethena",
  slug: "ethena",
  description:
    "Ethena Protocol: sUSDe staking vault (ERC-4626), USDe stablecoin, and ENA governance token on Ethereum",
  website: "https://ethena.fi",
  icon: "/protocols/ethena.png",

  testData: {
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
        "get-cooldown-duration": {},
        "get-cooldown-status": { account: wallet() },
        "get-usde-balance": { account: wallet() },
        "get-ena-balance": { account: wallet() },
        "approve-usde": { spender: wallet() },
        "cooldown-assets": {},
        "cooldown-shares": {},
        unstake: { receiver: wallet() },
        "vault-deposit": { receiver: wallet() },
        "vault-mint": { receiver: wallet() },
        "vault-withdraw": { receiver: wallet(), owner: wallet() },
        "vault-redeem": { receiver: wallet(), owner: wallet() },
      },
      skipped: {
        "vault-deposit": "requires USDe balance + approval",
        "vault-mint": "requires USDe balance + approval",
        "vault-withdraw": "requires sUSDe balance",
        "vault-redeem": "requires sUSDe balance",
        "cooldown-assets": "requires sUSDe balance to initiate cooldown",
        "cooldown-shares": "requires sUSDe balance to initiate cooldown",
        unstake: "requires completed cooldown period (7 days)",
        "approve-usde": "write action requiring prior USDe balance",
      },
    },
  },

  contracts: {
    sUsde: {
      label: "sUSDe (Staked USDe)",
      abi: SUSDE_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      },
      overrides: {
        // 18 standard ERC-4626 overrides
        ...erc4626AbiOverrides(),

        // Ethena-specific: cooldown writes
        cooldownAssets: {
          slug: "cooldown-assets",
          label: "Cooldown Assets",
          description:
            "Initiate the cooldown period to unstake a specific amount of underlying USDe assets. After the cooldown duration (7 days), call unstake to claim.",
          inputs: {
            assets: { label: "USDe Amount (wei)" },
          },
        },
        cooldownShares: {
          slug: "cooldown-shares",
          label: "Cooldown Shares",
          description:
            "Initiate the cooldown period to unstake a specific number of sUSDe shares. After the cooldown duration (7 days), call unstake to claim.",
          inputs: {
            shares: { label: "sUSDe Shares (wei)" },
          },
        },
        unstake: {
          label: "Unstake (Claim After Cooldown)",
          description:
            "Claim USDe after the cooldown period has elapsed. Must have previously called cooldownAssets or cooldownShares.",
          inputs: {
            receiver: { label: "Receiver Address" },
          },
        },

        // Ethena-specific: cooldown reads
        cooldownDuration: {
          slug: "get-cooldown-duration",
          label: "Get Cooldown Duration",
          description:
            "Get the current cooldown duration in seconds required before unstaking",
          outputs: {
            result: {
              name: "cooldownDuration",
              label: "Cooldown Duration (seconds)",
            },
          },
        },
        cooldowns: {
          slug: "get-cooldown-status",
          label: "Get Cooldown Status",
          description:
            "Get the cooldown end timestamp and USDe amount pending for an address",
          inputs: {
            // ABI param name is "" -- defaults to "arg0"
            arg0: { name: "account", label: "Wallet Address" },
          },
          outputs: {
            cooldownEnd: { label: "Cooldown End Timestamp" },
            underlyingAmount: { label: "Pending USDe Amount (wei)" },
          },
        },
      },
    },
    usde: {
      label: "USDe Stablecoin",
      abi: ERC20_MINIMAL_ABI,
      addresses: {
        "1": "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
      },
      overrides: {
        balanceOf: {
          slug: "get-usde-balance",
          label: "Get USDe Balance",
          description: "Check the USDe stablecoin balance of an address",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: { name: "balance", label: "USDe Balance (wei)", decimals: 18 },
          },
        },
        approve: {
          slug: "approve-usde",
          label: "Approve USDe Spending",
          description:
            "Approve a spender to transfer USDe on your behalf. Required before depositing into the sUSDe vault.",
          inputs: {
            spender: { label: "Spender Address" },
            amount: { label: "Approval Amount (wei)" },
          },
        },
      },
    },
    ena: {
      label: "ENA Governance Token",
      abi: ERC20_BALANCE_ABI,
      addresses: {
        "1": "0x57e114B691Db790C35207b2e685D4A43181e6061",
      },
      overrides: {
        balanceOf: {
          slug: "get-ena-balance",
          label: "Get ENA Balance",
          description: "Check the ENA governance token balance of an address",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: { name: "balance", label: "ENA Balance (wei)", decimals: 18 },
          },
        },
      },
    },
  },
});
