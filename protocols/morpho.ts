import { defineProtocol } from "@/lib/protocol-registry";
import { erc4626VaultActions } from "@/lib/web3/standards/erc4626";

export default defineProtocol({
  name: "Morpho",
  slug: "morpho",
  description:
    "Trustless lending protocol: overcollateralized borrowing and lending of ERC-20 tokens via a singleton contract",
  website: "https://app.morpho.org",
  icon: "/protocols/morpho.png",

  contracts: {
    morpho: {
      label: "Morpho Blue",
      addresses: {
        // Ethereum Mainnet
        "1": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
        // Base
        "8453": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
        // Sepolia
        "11155111": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    vault: {
      label: "MetaMorpho Vault",
      addresses: {},
      userSpecifiedAddress: true,
    },
  },

  actions: [
    // MetaMorpho ERC-4626 vault actions (user-specified vault address)
    ...erc4626VaultActions("vault"),

    // Morpho Blue lending market actions
    {
      slug: "get-position",
      label: "Get Position",
      description:
        "Check a user's supply shares, borrow shares, and collateral in a Morpho market",
      type: "read",
      contract: "morpho",
      function: "position",
      inputs: [
        { name: "id", type: "bytes32", label: "Market ID" },
        { name: "user", type: "address", label: "User Address" },
      ],
      outputs: [
        {
          name: "supplyShares",
          type: "uint256",
          label: "Supply Shares",
        },
        {
          name: "borrowShares",
          type: "uint128",
          label: "Borrow Shares",
        },
        {
          name: "collateral",
          type: "uint128",
          label: "Collateral",
        },
      ],
    },
    {
      slug: "get-market",
      label: "Get Market",
      description:
        "Check total supply, borrows, last update time, and fee for a Morpho market",
      type: "read",
      contract: "morpho",
      function: "market",
      inputs: [{ name: "id", type: "bytes32", label: "Market ID" }],
      outputs: [
        {
          name: "totalSupplyAssets",
          type: "uint128",
          label: "Total Supply Assets",
        },
        {
          name: "totalSupplyShares",
          type: "uint128",
          label: "Total Supply Shares",
        },
        {
          name: "totalBorrowAssets",
          type: "uint128",
          label: "Total Borrow Assets",
        },
        {
          name: "totalBorrowShares",
          type: "uint128",
          label: "Total Borrow Shares",
        },
        {
          name: "lastUpdate",
          type: "uint128",
          label: "Last Update Timestamp",
        },
        {
          name: "fee",
          type: "uint128",
          label: "Fee",
        },
      ],
    },
    {
      slug: "get-market-params",
      label: "Get Market Params",
      description:
        "Resolve a market ID to its parameters: loan token, collateral token, oracle, IRM, and LLTV",
      type: "read",
      contract: "morpho",
      function: "idToMarketParams",
      inputs: [{ name: "id", type: "bytes32", label: "Market ID" }],
      outputs: [
        {
          name: "loanToken",
          type: "address",
          label: "Loan Token",
        },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token",
        },
        {
          name: "oracle",
          type: "address",
          label: "Oracle",
        },
        {
          name: "irm",
          type: "address",
          label: "Interest Rate Model",
        },
        {
          name: "lltv",
          type: "uint256",
          label: "Liquidation LTV",
        },
      ],
    },
    {
      slug: "is-authorized",
      label: "Check Authorization",
      description:
        "Check if an address is authorized to act on behalf of another in Morpho",
      type: "read",
      contract: "morpho",
      function: "isAuthorized",
      inputs: [
        {
          name: "authorizer",
          type: "address",
          label: "Authorizer Address",
        },
        {
          name: "authorized",
          type: "address",
          label: "Authorized Address",
        },
      ],
      outputs: [
        {
          name: "isAuthorized",
          type: "bool",
          label: "Is Authorized",
        },
      ],
    },
    {
      slug: "set-authorization",
      label: "Set Authorization",
      description:
        "Grant or revoke authorization for another address to act on your behalf in Morpho",
      type: "write",
      contract: "morpho",
      function: "setAuthorization",
      inputs: [
        {
          name: "authorized",
          type: "address",
          label: "Authorized Address",
        },
        { name: "newIsAuthorized", type: "bool", label: "Authorize" },
      ],
    },
    {
      slug: "flash-loan",
      label: "Flash Loan",
      description:
        "Borrow tokens and repay within the same transaction via Morpho flash loan",
      type: "write",
      contract: "morpho",
      function: "flashLoan",
      inputs: [
        { name: "token", type: "address", label: "Token Address" },
        {
          name: "assets",
          type: "uint256",
          label: "Amount (wei)",
          decimals: true,
        },
        { name: "data", type: "bytes", label: "Callback Data" },
      ],
    },
    {
      slug: "supply",
      label: "Supply",
      description:
        "Supply loan tokens to a Morpho market. Specify amount in assets or shares (set the other to 0)",
      type: "write",
      contract: "morpho",
      function: "supply",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Asset Amount",
          decimals: true,
        },
        {
          name: "shares",
          type: "uint256",
          label: "Share Amount",
          default: "0",
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "data", type: "bytes", label: "Callback Data", default: "0x" },
      ],
    },
    {
      slug: "withdraw",
      label: "Withdraw",
      description:
        "Withdraw supplied loan tokens from a Morpho market. Specify amount in assets or shares (set the other to 0)",
      type: "write",
      contract: "morpho",
      function: "withdraw",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Asset Amount",
          decimals: true,
        },
        {
          name: "shares",
          type: "uint256",
          label: "Share Amount",
          default: "0",
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: "borrow",
      label: "Borrow",
      description:
        "Borrow loan tokens from a Morpho market against deposited collateral",
      type: "write",
      contract: "morpho",
      function: "borrow",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Asset Amount",
          decimals: true,
        },
        {
          name: "shares",
          type: "uint256",
          label: "Share Amount",
          default: "0",
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: "repay",
      label: "Repay",
      description:
        "Repay borrowed loan tokens to a Morpho market. Specify amount in assets or shares (set the other to 0)",
      type: "write",
      contract: "morpho",
      function: "repay",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Asset Amount",
          decimals: true,
        },
        {
          name: "shares",
          type: "uint256",
          label: "Share Amount",
          default: "0",
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "data", type: "bytes", label: "Callback Data", default: "0x" },
      ],
    },
    {
      slug: "supply-collateral",
      label: "Supply Collateral",
      description:
        "Deposit collateral tokens into a Morpho market for borrowing",
      type: "write",
      contract: "morpho",
      function: "supplyCollateral",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Collateral Amount",
          decimals: true,
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "data", type: "bytes", label: "Callback Data", default: "0x" },
      ],
    },
    {
      slug: "withdraw-collateral",
      label: "Withdraw Collateral",
      description: "Remove collateral tokens from a Morpho market position",
      type: "write",
      contract: "morpho",
      function: "withdrawCollateral",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Collateral Amount",
          decimals: true,
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: "liquidate",
      label: "Liquidate",
      description:
        "Liquidate an undercollateralized position in a Morpho market",
      type: "write",
      contract: "morpho",
      function: "liquidate",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        { name: "borrower", type: "address", label: "Borrower Address" },
        {
          name: "seizedAssets",
          type: "uint256",
          label: "Seized Collateral Amount",
          decimals: true,
        },
        {
          name: "repaidShares",
          type: "uint256",
          label: "Repaid Shares",
          default: "0",
        },
        { name: "data", type: "bytes", label: "Callback Data", default: "0x" },
      ],
    },
    {
      slug: "accrue-interest",
      label: "Accrue Interest",
      description:
        "Trigger interest accrual for a Morpho market to update supply and borrow indices",
      type: "write",
      contract: "morpho",
      function: "accrueInterest",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
      ],
    },
  ],
});
