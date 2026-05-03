import { defineProtocol } from "@/lib/protocol-registry";
import { erc4626VaultActions } from "@/lib/web3/standards/erc4626";
import sUsdeAbi from "./abis/ethena-susde.json";

const SUSDE_ABI = JSON.stringify(sUsdeAbi);

const ERC20_ABI = JSON.stringify([
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
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

export default defineProtocol({
  name: "Ethena",
  slug: "ethena",
  description:
    "Ethena Protocol -- sUSDe staking vault (ERC-4626), USDe stablecoin, and ENA governance token on Ethereum",
  website: "https://ethena.fi",
  icon: "/protocols/ethena.png",

  contracts: {
    sUsde: {
      label: "sUSDe (Staked USDe)",
      abi: SUSDE_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      },
    },
    usde: {
      label: "USDe Stablecoin",
      abi: ERC20_ABI,
      addresses: {
        "1": "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
      },
    },
    ena: {
      label: "ENA Governance Token",
      abi: ERC20_ABI,
      addresses: {
        "1": "0x57e114B691Db790C35207b2e685D4A43181e6061",
      },
    },
  },

  actions: [
    // ERC-4626 Vault (sUSDe Staking)
    ...erc4626VaultActions("sUsde"),

    // Cooldown Management

    {
      slug: "cooldown-assets",
      label: "Cooldown Assets",
      description:
        "Initiate the cooldown period to unstake a specific amount of underlying USDe assets. After the cooldown duration (7 days), call unstake to claim.",
      type: "write",
      contract: "sUsde",
      function: "cooldownAssets",
      inputs: [{ name: "assets", type: "uint256", label: "USDe Amount (wei)" }],
    },
    {
      slug: "cooldown-shares",
      label: "Cooldown Shares",
      description:
        "Initiate the cooldown period to unstake a specific number of sUSDe shares. After the cooldown duration (7 days), call unstake to claim.",
      type: "write",
      contract: "sUsde",
      function: "cooldownShares",
      inputs: [
        { name: "shares", type: "uint256", label: "sUSDe Shares (wei)" },
      ],
    },
    {
      slug: "unstake",
      label: "Unstake (Claim After Cooldown)",
      description:
        "Claim USDe after the cooldown period has elapsed. Must have previously called cooldownAssets or cooldownShares.",
      type: "write",
      contract: "sUsde",
      function: "unstake",
      inputs: [
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: "get-cooldown-duration",
      label: "Get Cooldown Duration",
      description:
        "Get the current cooldown duration in seconds required before unstaking",
      type: "read",
      contract: "sUsde",
      function: "cooldownDuration",
      inputs: [],
      outputs: [
        {
          name: "cooldownDuration",
          type: "uint24",
          label: "Cooldown Duration (seconds)",
        },
      ],
    },
    {
      slug: "get-cooldown-status",
      label: "Get Cooldown Status",
      description:
        "Get the cooldown end timestamp and USDe amount pending for an address",
      type: "read",
      contract: "sUsde",
      function: "cooldowns",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "cooldownEnd",
          type: "uint104",
          label: "Cooldown End Timestamp",
        },
        {
          name: "underlyingAmount",
          type: "uint152",
          label: "Pending USDe Amount (wei)",
        },
      ],
    },

    // Token Balances

    {
      slug: "get-usde-balance",
      label: "Get USDe Balance",
      description: "Check the USDe stablecoin balance of an address",
      type: "read",
      contract: "usde",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "USDe Balance (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-ena-balance",
      label: "Get ENA Balance",
      description: "Check the ENA governance token balance of an address",
      type: "read",
      contract: "ena",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "ENA Balance (wei)",
          decimals: 18,
        },
      ],
    },

    // Approvals

    {
      slug: "approve-usde",
      label: "Approve USDe Spending",
      description:
        "Approve a spender to transfer USDe on your behalf. Required before depositing into the sUSDe vault.",
      type: "write",
      contract: "usde",
      function: "approve",
      inputs: [
        { name: "spender", type: "address", label: "Spender Address" },
        { name: "amount", type: "uint256", label: "Approval Amount (wei)" },
      ],
    },
  ],
});
