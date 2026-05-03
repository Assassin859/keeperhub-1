import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: "Compound V3",
  slug: "compound",
  description:
    "Compound V3 (Comet) lending protocol: supply assets, borrow base tokens, and monitor balances across isolated markets",
  website: "https://compound.finance",
  icon: "/protocols/compound.png",

  contracts: {
    comet: {
      label: "Comet Market",
      userSpecifiedAddress: true,
      // Reference addresses (USDC market per chain) for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field,
      // since each Comet market (USDC, USDT, WETH) is a separate contract.
      addresses: {
        // Ethereum Mainnet (USDC market)
        "1": "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        // Base (USDC market)
        "8453": "0xb125E6687d4313864e53df431d5425969c15Eb2F",
        // Arbitrum One (USDC market)
        "42161": "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
      },
      // Inline ABI -- Comet is a proxy; block explorer auto-fetch fails on Base/Arbitrum
      abi: JSON.stringify([
        {
          type: "function",
          name: "supply",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "userCollateral",
          stateMutability: "view",
          inputs: [
            { name: "account", type: "address" },
            { name: "asset", type: "address" },
          ],
          outputs: [
            { name: "balance", type: "uint128" },
            { name: "_reserved", type: "uint128" },
          ],
        },
        {
          type: "function",
          name: "borrowBalanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "getUtilization",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "getSupplyRate",
          stateMutability: "view",
          inputs: [{ name: "utilization", type: "uint256" }],
          outputs: [{ name: "", type: "uint64" }],
        },
        {
          type: "function",
          name: "getBorrowRate",
          stateMutability: "view",
          inputs: [{ name: "utilization", type: "uint256" }],
          outputs: [{ name: "", type: "uint64" }],
        },
        {
          type: "function",
          name: "totalSupply",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "totalBorrow",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "isLiquidatable",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "bool" }],
        },
        {
          type: "function",
          name: "numAssets",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint8" }],
        },
      ]),
    },
  },

  actions: [
    // Supply / Withdraw

    {
      slug: "supply",
      label: "Supply Asset",
      description:
        "Supply base or collateral assets to a Compound V3 Comet market. Requires prior ERC-20 approval for the Comet contract.",
      type: "write",
      contract: "comet",
      function: "supply",
      inputs: [
        { name: "asset", type: "address", label: "Asset Token Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
      ],
    },
    {
      slug: "withdraw",
      label: "Withdraw Asset",
      description:
        "Withdraw base or collateral assets from a Compound V3 Comet market",
      type: "write",
      contract: "comet",
      function: "withdraw",
      inputs: [
        { name: "asset", type: "address", label: "Asset Token Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
      ],
    },

    // Read Actions

    {
      slug: "get-balance",
      label: "Get Base Balance",
      description:
        "Get the balance of the base asset (e.g. USDC) for an account in a Comet market",
      type: "read",
      contract: "comet",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Account Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "Base Asset Balance",
        },
      ],
    },
    {
      slug: "get-collateral-balance",
      label: "Get Collateral Balance",
      description:
        "Get the collateral balance of a specific asset for an account in a Comet market",
      type: "read",
      contract: "comet",
      function: "userCollateral",
      inputs: [
        { name: "account", type: "address", label: "Account Address" },
        { name: "asset", type: "address", label: "Collateral Asset Address" },
      ],
      outputs: [
        {
          name: "balance",
          type: "uint128",
          label: "Collateral Balance",
        },
      ],
    },
    {
      slug: "get-borrow-balance",
      label: "Get Borrow Balance",
      description:
        "Get the borrow balance of the base asset for an account in a Comet market",
      type: "read",
      contract: "comet",
      function: "borrowBalanceOf",
      inputs: [{ name: "account", type: "address", label: "Account Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "Borrow Balance",
        },
      ],
    },

    // Market analytics

    {
      slug: "get-utilization",
      label: "Get Utilization",
      description:
        "Get the current utilization rate of a Comet market (ratio of borrows to supply, scaled to 1e18)",
      type: "read",
      contract: "comet",
      function: "getUtilization",
      inputs: [],
      outputs: [
        {
          name: "utilization",
          type: "uint256",
          label: "Utilization Rate",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-supply-rate",
      label: "Get Supply Rate",
      description:
        "Get the per-second supply rate for a given utilization level. Multiply by seconds in a year (31536000) for APR.",
      type: "read",
      contract: "comet",
      function: "getSupplyRate",
      inputs: [
        {
          name: "utilization",
          type: "uint256",
          label: "Utilization (from Get Utilization)",
        },
      ],
      outputs: [
        {
          name: "rate",
          type: "uint64",
          label: "Supply Rate Per Second",
        },
      ],
    },
    {
      slug: "get-borrow-rate",
      label: "Get Borrow Rate",
      description:
        "Get the per-second borrow rate for a given utilization level. Multiply by seconds in a year (31536000) for APR.",
      type: "read",
      contract: "comet",
      function: "getBorrowRate",
      inputs: [
        {
          name: "utilization",
          type: "uint256",
          label: "Utilization (from Get Utilization)",
        },
      ],
      outputs: [
        {
          name: "rate",
          type: "uint64",
          label: "Borrow Rate Per Second",
        },
      ],
    },
    {
      slug: "get-total-supply",
      label: "Get Total Supply",
      description:
        "Get the total base asset supplied to a Comet market across all users",
      type: "read",
      contract: "comet",
      function: "totalSupply",
      inputs: [],
      outputs: [
        {
          name: "totalSupply",
          type: "uint256",
          label: "Total Supply",
        },
      ],
    },
    {
      slug: "get-total-borrow",
      label: "Get Total Borrow",
      description:
        "Get the total base asset borrowed from a Comet market across all users",
      type: "read",
      contract: "comet",
      function: "totalBorrow",
      inputs: [],
      outputs: [
        {
          name: "totalBorrow",
          type: "uint256",
          label: "Total Borrow",
        },
      ],
    },
    {
      slug: "is-liquidatable",
      label: "Is Liquidatable",
      description:
        "Check if an account is currently liquidatable in a Comet market",
      type: "read",
      contract: "comet",
      function: "isLiquidatable",
      inputs: [{ name: "account", type: "address", label: "Account Address" }],
      outputs: [
        {
          name: "isLiquidatable",
          type: "bool",
          label: "Is Liquidatable",
        },
      ],
    },
    {
      slug: "get-num-assets",
      label: "Get Number of Assets",
      description:
        "Get the number of collateral assets supported by a Comet market",
      type: "read",
      contract: "comet",
      function: "numAssets",
      inputs: [],
      outputs: [
        {
          name: "numAssets",
          type: "uint8",
          label: "Number of Collateral Assets",
        },
      ],
    },
  ],
});
