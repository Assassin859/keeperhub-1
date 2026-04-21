import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: "Aave V3",
  slug: "aave-v3",
  description:
    "Aave V3 lending and borrowing protocol -- supply, borrow, repay, and monitor account health",
  website: "https://aave.com",
  icon: "/protocols/aave.png",

  contracts: {
    pool: {
      label: "Aave V3 Pool",
      addresses: {
        // Ethereum Mainnet
        "1": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
        // Base
        "8453": "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
        // Arbitrum One
        "42161": "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        // Optimism
        "10": "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        // Sepolia Testnet
        "11155111": "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
      },
      // Proxy contract -- ABI auto-resolved via abi-cache
    },
    poolDataProvider: {
      label: "Aave V3 Pool Data Provider",
      addresses: {
        // Ethereum Mainnet
        "1": "0x7B4EB56E7CD4b454BA8ff71E4518426c03584755",
        // Base
        "8453": "0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac",
        // Arbitrum One
        "42161": "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654",
        // Optimism
        "10": "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654",
        // Sepolia Testnet
        "11155111": "0x3e9708d80f7B3e43118013075F7e95CE3AB31F31",
      },
      // ABI auto-resolved via abi-cache
    },
  },

  actions: [
    // Supply / Withdraw

    {
      slug: "supply",
      label: "Supply Asset",
      description:
        "Supply an asset to the Aave V3 lending pool to earn interest",
      type: "write",
      contract: "pool",
      function: "supply",
      inputs: [
        { name: "asset", type: "address", label: "Asset Token Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
        {
          name: "onBehalfOf",
          type: "address",
          label: "On Behalf Of Address",
        },
        {
          name: "referralCode",
          type: "uint16",
          label: "Referral Code",
          default: "0",
        },
      ],
    },
    {
      slug: "withdraw",
      label: "Withdraw Asset",
      description: "Withdraw a supplied asset from the Aave V3 lending pool",
      type: "write",
      contract: "pool",
      function: "withdraw",
      inputs: [
        { name: "asset", type: "address", label: "Asset Token Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
        { name: "to", type: "address", label: "Recipient Address" },
      ],
    },

    // Borrow / Repay

    {
      slug: "borrow",
      label: "Borrow Asset",
      description:
        "Borrow an asset from the Aave V3 lending pool against supplied collateral",
      type: "write",
      contract: "pool",
      function: "borrow",
      inputs: [
        { name: "asset", type: "address", label: "Asset Token Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
        {
          name: "interestRateMode",
          type: "uint256",
          label: "Interest Rate Mode (2=Variable)",
          default: "2",
        },
        {
          name: "referralCode",
          type: "uint16",
          label: "Referral Code",
          default: "0",
        },
        {
          name: "onBehalfOf",
          type: "address",
          label: "On Behalf Of Address",
        },
      ],
    },
    {
      slug: "repay",
      label: "Repay Debt",
      description: "Repay a borrowed asset to the Aave V3 lending pool",
      type: "write",
      contract: "pool",
      function: "repay",
      inputs: [
        { name: "asset", type: "address", label: "Asset Token Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
        {
          name: "interestRateMode",
          type: "uint256",
          label: "Interest Rate Mode (2=Variable)",
          default: "2",
        },
        {
          name: "onBehalfOf",
          type: "address",
          label: "On Behalf Of Address",
        },
      ],
    },

    // Collateral Management

    {
      slug: "set-collateral",
      label: "Set Asset as Collateral",
      description:
        "Enable or disable a supplied asset as collateral in Aave V3",
      type: "write",
      contract: "pool",
      function: "setUserUseReserveAsCollateral",
      inputs: [
        { name: "asset", type: "address", label: "Asset Token Address" },
        {
          name: "useAsCollateral",
          type: "bool",
          label: "Use as Collateral",
          helpTip:
            "Toggles the entire supplied balance of this asset as collateral. There is no partial collateral in Aave V3.",
        },
      ],
    },

    // Read Actions

    {
      slug: "get-user-account-data",
      label: "Get User Account Data",
      description:
        "Get overall account health including collateral, debt, borrow power, and health factor",
      type: "read",
      contract: "pool",
      function: "getUserAccountData",
      inputs: [{ name: "user", type: "address", label: "User Address" }],
      outputs: [
        {
          name: "totalCollateralBase",
          type: "uint256",
          label: "Total Collateral (base currency)",
          decimals: 8,
        },
        {
          name: "totalDebtBase",
          type: "uint256",
          label: "Total Debt (base currency)",
          decimals: 8,
        },
        {
          name: "availableBorrowsBase",
          type: "uint256",
          label: "Available Borrows (base currency)",
          decimals: 8,
        },
        {
          name: "currentLiquidationThreshold",
          type: "uint256",
          label: "Liquidation Threshold (basis points)",
        },
        {
          name: "ltv",
          type: "uint256",
          label: "Loan-to-Value (basis points)",
        },
        {
          name: "healthFactor",
          type: "uint256",
          label: "Health Factor",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-user-reserve-data",
      label: "Get User Reserve Data",
      description:
        "Get per-asset position data including supplied balance, debt, and rates",
      type: "read",
      contract: "poolDataProvider",
      function: "getUserReserveData",
      inputs: [
        { name: "asset", type: "address", label: "Asset Token Address" },
        { name: "user", type: "address", label: "User Address" },
      ],
      outputs: [
        {
          name: "currentATokenBalance",
          type: "uint256",
          label: "Supplied Balance (aToken)",
        },
        {
          name: "currentStableDebtTokenBalance",
          type: "uint256",
          label: "Stable Debt Balance",
        },
        {
          name: "currentVariableDebtTokenBalance",
          type: "uint256",
          label: "Variable Debt Balance",
        },
        {
          name: "principalStableDebt",
          type: "uint256",
          label: "Principal Stable Debt",
        },
        {
          name: "scaledVariableDebt",
          type: "uint256",
          label: "Scaled Variable Debt",
        },
        {
          name: "stableBorrowRate",
          type: "uint256",
          label: "Stable Borrow Rate (ray)",
          decimals: 27,
        },
        {
          name: "liquidityRate",
          type: "uint256",
          label: "Supply APY (ray)",
          decimals: 27,
        },
        {
          name: "stableRateLastUpdated",
          type: "uint40",
          label: "Stable Rate Last Updated (timestamp)",
        },
        {
          name: "usageAsCollateralEnabled",
          type: "bool",
          label: "Used as Collateral",
        },
      ],
    },
  ],
});
