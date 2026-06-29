import { defineAbiProtocol } from "@/lib/protocol-registry";

export default defineAbiProtocol({
  name: "Pendle Finance",
  slug: "pendle",
  description:
    "Pendle Finance: yield tokenization protocol for trading fixed and variable yield on DeFi assets",
  website: "https://pendle.finance",
  icon: "/protocols/pendle.png",

  contracts: {
    router: {
      label: "PendleRouter",
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "mintPyFromSy",
          stateMutability: "nonpayable",
          inputs: [
            { name: "receiver", type: "address" },
            { name: "YT", type: "address" },
            { name: "netSyIn", type: "uint256" },
            { name: "minPyOut", type: "uint256" },
          ],
          outputs: [{ name: "netPyOut", type: "uint256" }],
        },
        {
          type: "function",
          name: "redeemPyToSy",
          stateMutability: "nonpayable",
          inputs: [
            { name: "receiver", type: "address" },
            { name: "YT", type: "address" },
            { name: "netPyIn", type: "uint256" },
            { name: "minSyOut", type: "uint256" },
          ],
          outputs: [{ name: "netSyOut", type: "uint256" }],
        },
      ]),
      overrides: {
        mintPyFromSy: {
          label: "Mint PT and YT from SY",
          description:
            "Split Standardized Yield tokens into Principal Tokens and Yield Tokens",
          inputs: {
            receiver: { label: "Receiver Address" },
            YT: { label: "YT Token Address" },
            netSyIn: { label: "SY Amount (wei)" },
            minPyOut: { label: "Minimum PT/YT Out (wei)" },
          },
        },
        redeemPyToSy: {
          label: "Redeem PT and YT to SY",
          description:
            "Merge Principal Tokens and Yield Tokens back into Standardized Yield tokens",
          inputs: {
            receiver: { label: "Receiver Address" },
            YT: { label: "YT Token Address" },
            netPyIn: { label: "PT/YT Amount (wei)" },
            minSyOut: { label: "Minimum SY Out (wei)" },
          },
        },
      },
    },

    vePendle: {
      label: "vePENDLE",
      addresses: {
        // Ethereum Mainnet
        "1": "0x4f30A9D41B80ecC5B94306AB4364951AE3170210",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "user", type: "address" }],
          outputs: [{ name: "", type: "uint128" }],
        },
        {
          type: "function",
          name: "totalSupplyStored",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint128" }],
        },
        {
          type: "function",
          name: "positionData",
          stateMutability: "view",
          inputs: [{ name: "user", type: "address" }],
          outputs: [
            { name: "amount", type: "uint128" },
            { name: "expiry", type: "uint128" },
          ],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "get-ve-pendle-balance",
          label: "Get vePENDLE Balance",
          description:
            "Check the vePENDLE voting power balance of an address",
          inputs: {
            user: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "vePENDLE Balance", decimals: 18 },
          },
        },
        totalSupplyStored: {
          slug: "get-ve-pendle-total-supply",
          label: "Get vePENDLE Total Supply",
          description:
            "Get the stored total vePENDLE supply across all lockers",
          outputs: {
            result: {
              name: "totalSupply",
              label: "Total vePENDLE Supply",
              decimals: 18,
            },
          },
        },
        positionData: {
          slug: "get-ve-pendle-position",
          label: "Get vePENDLE Lock Position",
          description:
            "Get the lock position data for an address (amount and expiry)",
          inputs: {
            user: { label: "Wallet Address" },
          },
          outputs: {
            amount: { label: "Locked PENDLE Amount" },
            expiry: { label: "Lock Expiry Timestamp" },
          },
        },
      },
    },

    market: {
      label: "Pendle Market",
      userSpecifiedAddress: true,
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "expiry",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "isExpired",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "bool" }],
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
          name: "activeBalance",
          stateMutability: "view",
          inputs: [{ name: "user", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "event",
          name: "Swap",
          inputs: [
            { name: "caller", type: "address", indexed: true },
            { name: "receiver", type: "address", indexed: true },
            { name: "netPtOut", type: "int256", indexed: false },
            { name: "netSyOut", type: "int256", indexed: false },
            { name: "netSyFee", type: "uint256", indexed: false },
            { name: "netSyToReserve", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "Mint",
          inputs: [
            { name: "receiver", type: "address", indexed: true },
            { name: "netLpMinted", type: "uint256", indexed: false },
            { name: "netSyUsed", type: "uint256", indexed: false },
            { name: "netPtUsed", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "Burn",
          inputs: [
            { name: "receiverSy", type: "address", indexed: true },
            { name: "receiverPt", type: "address", indexed: true },
            { name: "netLpBurned", type: "uint256", indexed: false },
            { name: "netSyOut", type: "uint256", indexed: false },
            { name: "netPtOut", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "UpdateImpliedRate",
          inputs: [
            { name: "timestamp", type: "uint256", indexed: true },
            { name: "lnLastImpliedRate", type: "uint256", indexed: false },
          ],
        },
      ]),
      overrides: {
        expiry: {
          slug: "get-market-expiry",
          label: "Get Market Expiry",
          description: "Get the expiry timestamp of a Pendle market",
          outputs: {
            result: { name: "expiry", label: "Expiry Timestamp" },
          },
        },
        isExpired: {
          slug: "is-market-expired",
          label: "Is Market Expired",
          description:
            "Check whether a Pendle market has passed its expiry date",
          outputs: {
            result: { name: "expired", label: "Is Expired" },
          },
        },
        balanceOf: {
          slug: "get-lp-balance",
          label: "Get LP Balance",
          description:
            "Check the LP token balance for a Pendle market position",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "LP Token Balance", decimals: 18 },
          },
        },
        activeBalance: {
          slug: "get-active-lp-balance",
          label: "Get Active LP Balance",
          description:
            "Check the active (non-expired) LP balance earning rewards in a Pendle market",
          inputs: {
            user: { label: "Wallet Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "Active LP Balance",
              decimals: 18,
            },
          },
        },
      },
      events: {
        Swap: {
          slug: "market-swap",
          label: "Market Swap",
          description:
            "Fires when a swap occurs in a Pendle market (PT/SY exchange)",
        },
        Mint: {
          slug: "market-mint",
          label: "Market LP Minted",
          description:
            "Fires when liquidity is added to a Pendle market (LP tokens minted)",
        },
        Burn: {
          slug: "market-burn",
          label: "Market LP Burned",
          description:
            "Fires when liquidity is removed from a Pendle market (LP tokens burned)",
        },
        UpdateImpliedRate: {
          slug: "update-implied-rate",
          label: "Implied Rate Updated",
          description:
            "Fires when the implied yield rate changes in a Pendle market",
        },
      },
    },

    pt: {
      label: "Principal Token (PT)",
      userSpecifiedAddress: true,
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "isExpired",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "bool" }],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "get-pt-balance",
          label: "Get PT Balance",
          description: "Check the Principal Token balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "PT Balance", decimals: 18 },
          },
        },
        isExpired: {
          slug: "is-pt-expired",
          label: "Is PT Expired",
          description:
            "Check whether a Principal Token has passed its maturity date",
          outputs: {
            result: { name: "expired", label: "Is Expired" },
          },
        },
      },
    },

    yt: {
      label: "Yield Token (YT)",
      userSpecifiedAddress: true,
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "event",
          name: "Mint",
          inputs: [
            { name: "caller", type: "address", indexed: true },
            { name: "receiverPT", type: "address", indexed: true },
            { name: "receiverYT", type: "address", indexed: true },
            { name: "amountSyToMint", type: "uint256", indexed: false },
            { name: "amountPYOut", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "Burn",
          inputs: [
            { name: "caller", type: "address", indexed: true },
            { name: "receiver", type: "address", indexed: true },
            { name: "amountPYToRedeem", type: "uint256", indexed: false },
            { name: "amountSyOut", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "RedeemRewards",
          inputs: [{ name: "user", type: "address", indexed: true }],
        },
        {
          type: "event",
          name: "RedeemInterest",
          inputs: [
            { name: "user", type: "address", indexed: true },
            { name: "interestOut", type: "uint256", indexed: false },
          ],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "get-yt-balance",
          label: "Get YT Balance",
          description: "Check the Yield Token balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "YT Balance", decimals: 18 },
          },
        },
      },
      events: {
        Mint: {
          slug: "yt-mint",
          label: "PT/YT Minted",
          description:
            "Fires when SY is split into PT and YT via the Yield Token contract",
        },
        Burn: {
          slug: "yt-burn",
          label: "PT/YT Redeemed",
          description:
            "Fires when PT and YT are merged back into SY via the Yield Token contract",
        },
        RedeemRewards: {
          slug: "redeem-rewards",
          label: "Rewards Redeemed",
          description:
            "Fires when a user claims accrued rewards from a Yield Token position",
        },
        RedeemInterest: {
          slug: "redeem-interest",
          label: "Interest Redeemed",
          description:
            "Fires when a user claims accrued interest from a Yield Token position",
        },
      },
    },

    sy: {
      label: "Standardized Yield (SY)",
      userSpecifiedAddress: true,
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "exchangeRate",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "get-sy-balance",
          label: "Get SY Balance",
          description:
            "Check the Standardized Yield token balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "SY Balance", decimals: 18 },
          },
        },
        exchangeRate: {
          slug: "get-sy-exchange-rate",
          label: "Get SY Exchange Rate",
          description:
            "Get the current exchange rate between SY and its underlying asset",
          outputs: {
            result: {
              name: "exchangeRate",
              label: "Exchange Rate",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
