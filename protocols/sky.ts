import { defineProtocol } from "@/lib/protocol-registry";
import { erc4626VaultActions } from "@/lib/web3/standards/erc4626";

export default defineProtocol({
  name: "Sky",
  slug: "sky",
  description:
    "Sky Protocol (formerly MakerDAO): USDS savings, token management, and DAI/MKR migration",
  website: "https://sky.money",
  icon: "/protocols/sky.png",

  contracts: {
    sUsds: {
      label: "sUSDS (Savings USDS)",
      // Proxy contract
      addresses: {
        // Ethereum Mainnet
        "1": "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
        // Base
        "8453": "0x5875eEE11Cf8398102FdAd704C9E96607675467a",
        // Arbitrum One
        "42161": "0xdDb46999F8891663a8F2828d25298f70416d7610",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    stUsds: {
      label: "stUSDS (Staked USDS)",
      addresses: {
        // Ethereum Mainnet
        "1": "0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    usds: {
      label: "USDS Stablecoin",
      // Proxy contract
      addresses: {
        // Ethereum Mainnet
        "1": "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
        // Base
        "8453": "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
        // Arbitrum One
        "42161": "0x6491c05A82219b8D1479057361ff1654749b876b",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    dai: {
      label: "DAI Stablecoin (Legacy)",
      addresses: {
        // Ethereum Mainnet
        "1": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    sky: {
      label: "SKY Governance Token",
      addresses: {
        // Ethereum Mainnet
        "1": "0x56072C95FAA701256059aa122697B133aDEd9279",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    daiUsdsConverter: {
      label: "DAI-USDS Converter",
      addresses: {
        // Ethereum Mainnet
        "1": "0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    mkrSkyConverter: {
      label: "MKR-SKY Converter",
      addresses: {
        // Ethereum Mainnet
        "1": "0xA1Ea1bA18E88C381C724a75F23a130420C403f9a",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
  },

  actions: [
    // ERC-4626 Vault (sUSDS Savings)
    ...erc4626VaultActions("sUsds"),

    // ERC-4626 Vault (stUSDS Staked)
    ...erc4626VaultActions("stUsds", {
      slugPrefix: "st-usds",
      labelPrefix: "stUSDS",
    }),

    // Token Balances

    {
      slug: "get-usds-balance",
      label: "Get USDS Balance",
      description: "Check the USDS balance of an address",
      type: "read",
      contract: "usds",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "USDS Balance (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-dai-balance",
      label: "Get DAI Balance",
      description: "Check the DAI balance of an address",
      type: "read",
      contract: "dai",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "DAI Balance (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-sky-balance",
      label: "Get SKY Balance",
      description: "Check the SKY balance of an address",
      type: "read",
      contract: "sky",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "SKY Balance (wei)",
          decimals: 18,
        },
      ],
    },

    // Approvals

    {
      slug: "approve-usds",
      label: "Approve USDS Spending",
      description: "Approve a spender to transfer USDS on your behalf",
      type: "write",
      contract: "usds",
      function: "approve",
      inputs: [
        { name: "spender", type: "address", label: "Spender Address" },
        { name: "amount", type: "uint256", label: "Approval Amount (wei)" },
      ],
    },
    {
      slug: "approve-dai",
      label: "Approve DAI Spending",
      description: "Approve a spender to transfer DAI on your behalf",
      type: "write",
      contract: "dai",
      function: "approve",
      inputs: [
        { name: "spender", type: "address", label: "Spender Address" },
        { name: "amount", type: "uint256", label: "Approval Amount (wei)" },
      ],
    },

    // Converters

    {
      slug: "convert-dai-to-usds",
      label: "Convert DAI to USDS",
      description:
        "Convert DAI to USDS at a 1:1 rate via the official converter (Ethereum only)",
      type: "write",
      contract: "daiUsdsConverter",
      function: "daiToUsds",
      inputs: [
        { name: "usr", type: "address", label: "Recipient Address" },
        { name: "amount", type: "uint256", label: "DAI Amount (wei)" },
      ],
    },
    {
      slug: "convert-usds-to-dai",
      label: "Convert USDS to DAI",
      description:
        "Convert USDS back to DAI at a 1:1 rate via the official converter (Ethereum only)",
      type: "write",
      contract: "daiUsdsConverter",
      function: "usdsToDai",
      inputs: [
        { name: "usr", type: "address", label: "Recipient Address" },
        { name: "amount", type: "uint256", label: "USDS Amount (wei)" },
      ],
    },
    {
      slug: "convert-mkr-to-sky",
      label: "Convert MKR to SKY",
      description:
        "Convert MKR governance tokens to SKY via the official converter (Ethereum only)",
      type: "write",
      contract: "mkrSkyConverter",
      function: "mkrToSky",
      inputs: [
        { name: "usr", type: "address", label: "Recipient Address" },
        { name: "mkrAmt", type: "uint256", label: "MKR Amount (wei)" },
      ],
    },
  ],
});
