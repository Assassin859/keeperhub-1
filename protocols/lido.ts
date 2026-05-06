import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: "Lido",
  slug: "lido",
  description:
    "Liquid staking for Ethereum: wrap stETH to wstETH, unwrap back, and query exchange rates",
  website: "https://lido.fi",
  icon: "/protocols/lido.png",

  contracts: {
    wsteth: {
      label: "wstETH (Wrapped stETH)",
      addresses: {
        // Ethereum Mainnet
        "1": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
        // Base
        "8453": "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
        // Sepolia Testnet
        "11155111": "0xB82381A3fBD3FaFA77B3a7bE693342618240067b",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    steth: {
      label: "stETH (Lido Staked ETH)",
      addresses: {
        // Ethereum Mainnet -- proxy
        "1": "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
        // Sepolia Testnet
        "11155111": "0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af",
      },
      // Inline ABI -- Lido's AppProxy ABI auto-resolution doesn't include ERC20 functions
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "_account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_spender", type: "address" },
            { name: "_amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ]),
    },
  },

  actions: [
    // Write Actions

    {
      slug: "wrap",
      label: "Wrap stETH to wstETH",
      description:
        "Wrap stETH tokens into non-rebasing wstETH (requires stETH approval first)",
      type: "write",
      contract: "wsteth",
      function: "wrap",
      inputs: [
        {
          name: "_stETHAmount",
          type: "uint256",
          label: "stETH Amount (wei)",
        },
      ],
    },
    {
      slug: "unwrap",
      label: "Unwrap wstETH to stETH",
      description:
        "Unwrap wstETH back to rebasing stETH at the current exchange rate",
      type: "write",
      contract: "wsteth",
      function: "unwrap",
      inputs: [
        {
          name: "_wstETHAmount",
          type: "uint256",
          label: "wstETH Amount (wei)",
        },
      ],
    },
    {
      slug: "approve-steth",
      label: "Approve stETH Spending",
      description:
        "Approve the wstETH contract (or another spender) to transfer stETH on your behalf",
      type: "write",
      contract: "steth",
      function: "approve",
      inputs: [
        { name: "spender", type: "address", label: "Spender Address" },
        { name: "amount", type: "uint256", label: "Approval Amount (wei)" },
      ],
    },

    // Read Actions

    {
      slug: "get-steth-by-wsteth",
      label: "Get stETH by wstETH",
      description:
        "Convert a wstETH amount to its equivalent stETH value at the current rate",
      type: "read",
      contract: "wsteth",
      function: "getStETHByWstETH",
      inputs: [
        {
          name: "_wstETHAmount",
          type: "uint256",
          label: "wstETH Amount (wei)",
        },
      ],
      outputs: [
        {
          name: "stETHAmount",
          type: "uint256",
          label: "stETH Value (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-wsteth-by-steth",
      label: "Get wstETH by stETH",
      description:
        "Convert a stETH amount to its equivalent wstETH value at the current rate",
      type: "read",
      contract: "wsteth",
      function: "getWstETHByStETH",
      inputs: [
        {
          name: "_stETHAmount",
          type: "uint256",
          label: "stETH Amount (wei)",
        },
      ],
      outputs: [
        {
          name: "wstETHAmount",
          type: "uint256",
          label: "wstETH Value (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "steth-per-token",
      label: "stETH Per Token (Exchange Rate)",
      description:
        "Get the current stETH value of 1 wstETH (exchange rate from wstETH to stETH)",
      type: "read",
      contract: "wsteth",
      function: "stEthPerToken",
      inputs: [],
      outputs: [
        {
          name: "rate",
          type: "uint256",
          label: "stETH per wstETH (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "tokens-per-steth",
      label: "wstETH Per stETH (Inverse Rate)",
      description:
        "Get the current wstETH value of 1 stETH (inverse exchange rate)",
      type: "read",
      contract: "wsteth",
      function: "tokensPerStEth",
      inputs: [],
      outputs: [
        {
          name: "rate",
          type: "uint256",
          label: "wstETH per stETH (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-wsteth-balance",
      label: "Get wstETH Balance",
      description: "Check the wstETH balance of an address",
      type: "read",
      contract: "wsteth",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "wstETH Balance (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-wsteth-total-supply",
      label: "Get wstETH Total Supply",
      description: "Get the total supply of wstETH tokens",
      type: "read",
      contract: "wsteth",
      function: "totalSupply",
      inputs: [],
      outputs: [
        {
          name: "totalSupply",
          type: "uint256",
          label: "Total wstETH Supply (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-steth-balance",
      label: "Get stETH Balance",
      description: "Check the stETH balance of an address",
      type: "read",
      contract: "steth",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "stETH Balance (wei)",
          decimals: 18,
        },
      ],
    },
  ],

  events: [
    {
      slug: "steth-submitted",
      label: "ETH Submitted for stETH",
      description: "Fires when ETH is submitted to Lido for stETH",
      eventName: "Submitted",
      contract: "steth",
      inputs: [
        { name: "sender", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
        { name: "referral", type: "address", indexed: false },
      ],
    },
  ],
});
