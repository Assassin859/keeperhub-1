import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: "Curve",
  slug: "curve",
  description:
    "Curve Finance: stableswap pools, token exchanges, liquidity management, and CRV token operations",
  website: "https://curve.fi",
  icon: "/protocols/curve.png",

  contracts: {
    pool: {
      label: "Curve Pool",
      userSpecifiedAddress: true,
      // Reference addresses for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field.
      addresses: {
        // Ethereum Mainnet (3pool)
        "1": "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
        // Base (4pool)
        "8453": "0x6e53131F68a034873b6bFA15502aF094Ef0c5854",
        // Arbitrum One (2CRV)
        "42161": "0x7f90122BF0700F9E7e1F688fe926940E8839F353",
        // Optimism (3pool)
        "10": "0x1337BedC9D22ecbe766dF105c9623922A27963EC",
      },
    },
    crvToken: {
      label: "CRV Token",
      addresses: {
        // Ethereum Mainnet
        "1": "0xD533a949740bb3306d119CC777fa900bA034cd52",
        // Arbitrum One
        "42161": "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978",
        // Optimism
        "10": "0x0994206dfE8De6Ec6920FF4D779B0d950605Fb53",
      },
    },
  },

  actions: [
    // Pool Reads

    {
      slug: "get-dy",
      label: "Get Expected Output",
      description:
        "Get the expected output amount for a token exchange in a Curve pool",
      type: "read",
      contract: "pool",
      function: "get_dy",
      inputs: [
        { name: "i", type: "int128", label: "Input Coin Index" },
        { name: "j", type: "int128", label: "Output Coin Index" },
        { name: "dx", type: "uint256", label: "Input Amount (wei)" },
      ],
      outputs: [
        {
          name: "dy",
          type: "uint256",
          label: "Expected Output (wei)",
        },
      ],
    },
    {
      slug: "get-virtual-price",
      label: "Get Virtual Price",
      description: "Get the virtual price of the pool's LP token",
      type: "read",
      contract: "pool",
      function: "get_virtual_price",
      inputs: [],
      outputs: [
        {
          name: "virtualPrice",
          type: "uint256",
          label: "Virtual Price",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-coin",
      label: "Get Coin Address",
      description: "Get the token address at a specific index in the pool",
      type: "read",
      contract: "pool",
      function: "coins",
      inputs: [{ name: "arg0", type: "uint256", label: "Coin Index" }],
      outputs: [{ name: "coin", type: "address", label: "Token Address" }],
    },
    {
      slug: "get-pool-balance",
      label: "Get Pool Balance",
      description: "Get the pool's balance of a specific coin by index",
      type: "read",
      contract: "pool",
      function: "balances",
      inputs: [{ name: "arg0", type: "uint256", label: "Coin Index" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "Coin Balance (wei)",
        },
      ],
    },

    {
      slug: "calc-withdraw-one-coin",
      label: "Calculate Withdraw One Coin",
      description:
        "Calculate the amount received when withdrawing a single coin from the pool",
      type: "read",
      contract: "pool",
      function: "calc_withdraw_one_coin",
      inputs: [
        {
          name: "_token_amount",
          type: "uint256",
          label: "LP Token Amount (wei)",
        },
        { name: "i", type: "int128", label: "Output Coin Index" },
      ],
      outputs: [
        {
          name: "amount",
          type: "uint256",
          label: "Withdraw Amount (wei)",
        },
      ],
    },

    // Pool Writes

    {
      slug: "exchange",
      label: "Exchange Tokens",
      description: "Swap tokens in a Curve pool",
      type: "write",
      contract: "pool",
      function: "exchange",
      inputs: [
        { name: "i", type: "int128", label: "Input Coin Index" },
        { name: "j", type: "int128", label: "Output Coin Index" },
        { name: "dx", type: "uint256", label: "Input Amount (wei)" },
        { name: "min_dy", type: "uint256", label: "Minimum Output (wei)" },
      ],
    },
    {
      slug: "remove-liquidity-one-coin",
      label: "Remove Liquidity (Single Coin)",
      description: "Withdraw liquidity from a Curve pool as a single token",
      type: "write",
      contract: "pool",
      function: "remove_liquidity_one_coin",
      inputs: [
        {
          name: "_token_amount",
          type: "uint256",
          label: "LP Token Amount (wei)",
        },
        { name: "i", type: "int128", label: "Output Coin Index" },
        { name: "_min_amount", type: "uint256", label: "Minimum Output (wei)" },
      ],
    },

    // CRV Token Reads

    {
      slug: "crv-balance-of",
      label: "Get CRV Balance",
      description: "Check CRV token balance of an address",
      type: "read",
      contract: "crvToken",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "CRV Balance",
          decimals: 18,
        },
      ],
    },

    // CRV Token Writes

    {
      slug: "crv-approve",
      label: "Approve CRV",
      description: "Approve an address to spend CRV tokens",
      type: "write",
      contract: "crvToken",
      function: "approve",
      inputs: [
        { name: "spender", type: "address", label: "Spender Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
      ],
    },
    {
      slug: "crv-transfer",
      label: "Transfer CRV",
      description: "Transfer CRV tokens to an address",
      type: "write",
      contract: "crvToken",
      function: "transfer",
      inputs: [
        { name: "to", type: "address", label: "Recipient Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
      ],
    },
  ],
});
