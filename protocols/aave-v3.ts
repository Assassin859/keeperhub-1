import { defineProtocol } from "@/lib/protocol-registry";
import {
  amount,
  contract,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";
import aaveV3PoolAbi from "./abis/aave-v3-pool.json";

// KEEP-458 protocol-coverage test data. Co-located with the protocol
// definition; consumed programmatically by `lib/test-data/build-workflow.ts`.
//
// Sepolia uses the Aave V3 testnet LINK reserve. DAI/USDC/USDT all hit
// `SUPPLY_CAP_EXCEEDED` (error 51) on Aave Sepolia, verified 2026-05-12
// via eth_call against Pool.supply(). LINK has headroom and is borrowable.
// Setup mints LINK via the permissionless Aave faucet, approves the Pool,
// then supplies 100 LINK so the write coverage (withdraw/borrow/repay/
// set-collateral) has a real position to operate on.
const TEST_DATA: ProtocolTestData = {
  "11155111": {
    setup: {
      minNativeHuman: "0.001",
      // 100 LINK initial supply + 10 LINK per-test supply + buffer.
      requiredTokens: [{ symbol: "LINK", human: "200" }],
      approvals: [{ token: "LINK", spender: contract("pool"), human: "200" }],
      protocolSteps: [
        {
          protocol: "aave-v3",
          action: "supply",
          inputs: {
            asset: "LINK",
            amount: amount("LINK", "100"),
            onBehalfOf: wallet(),
            referralCode: "0",
          },
        },
      ],
    },
    actions: {
      "get-user-account-data": {
        user: wallet(),
      },
      "get-user-reserve-data": {
        asset: "LINK",
        user: wallet(),
      },
      supply: {
        asset: "LINK",
        amount: amount("LINK", "10"),
        onBehalfOf: wallet(),
        referralCode: "0",
      },
      withdraw: {
        asset: "LINK",
        amount: amount("LINK", "1"),
        to: wallet(),
      },
      borrow: {
        asset: "LINK",
        amount: amount("LINK", "1"),
        interestRateMode: "2",
        referralCode: "0",
        onBehalfOf: wallet(),
      },
      repay: {
        asset: "LINK",
        amount: amount("LINK", "1"),
        interestRateMode: "2",
        onBehalfOf: wallet(),
      },
      "set-collateral": {
        asset: "LINK",
        useAsCollateral: "true",
      },
    },
  },
};

export default defineProtocol({
  name: "Aave V3",
  slug: "aave-v3",
  description:
    "Aave V3 lending and borrowing protocol: supply, borrow, repay, and monitor account health",
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
      // Aave V3 Pool is a custom upgradeable proxy
      // (InitializableImmutableAdminUpgradeabilityProxy). Etherscan's
      // getsourcecode does not flag it as a proxy and getabi returns the
      // proxy's own ABI (admin/implementation/upgradeTo), so the
      // auto-resolver fails to find pool functions on mainnet.
      // Embed the implementation ABI inline so resolveAbi short-circuits
      // via the "definition" source. KEEP-396.
      abi: JSON.stringify(aaveV3PoolAbi),
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

  // KEEP-458: the protocol-coverage test runner executes write actions in
  // the order they appear below (`protocol.actions.filter(type==='write')`
  // preserves array order, and vitest within a file runs tests sequentially).
  // Tests share the wallet's on-chain Aave position as a singleton, so order
  // matters:
  //   - repay MUST follow borrow (otherwise no open debt -> reverts).
  //   - withdraw works in any post-setup slot (setup supplies 100 LINK; tests
  //     only move 1 LINK so health-factor headroom is not a concern).
  //   - supply auto-enables LINK as collateral on Aave V3 when LTV > 0, so
  //     borrow does not require set-collateral to run first.
  // Reordering this array (e.g. alphabetising) will silently break the suite.
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

  testData: TEST_DATA,
});
