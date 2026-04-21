import { defineAbiProtocol } from "@/lib/protocol-registry";
import aaveV4Abi from "./abis/aave-v4.json";

// Aave V4 launched on Ethereum mainnet 2026-03-30 with a Hub-and-Spoke
// architecture. Users interact with Spokes (not Hubs) for supply/borrow.
// Each Spoke is tied to an ecosystem partner and has its own set of reserves
// identified by an opaque uint256 reserveId. Use `get-reserve-id` to resolve
// an asset into its reserveId before calling supply/withdraw/borrow/repay.
//
// This first cut exposes the Lido Spoke only - the most established of the
// six launch Spokes (Lido, EtherFi, Kelp, Ethena Correlated, Ethena
// Ecosystem, Lombard BTC). Additional Spokes can be added as contract
// entries sharing the same ABI.
//
// Integration tests are gated on the separate aave-v4-mainnet-onchain
// test file - no Sepolia V4 deployment exists at launch.

export default defineAbiProtocol({
  name: "Aave V4",
  slug: "aave-v4",
  description:
    "Aave V4 Hub-and-Spoke lending protocol - supply, borrow, repay and monitor positions via the Lido Spoke",
  website: "https://aave.com",
  icon: "/protocols/aave.png",

  contracts: {
    lidoSpoke: {
      label: "Aave V4 Lido Spoke",
      abi: JSON.stringify(aaveV4Abi),
      addresses: {
        "1": "0xe1900480ac69f0B296841Cd01cC37546d92F35Cd",
      },
      overrides: {
        // Write actions (supply/withdraw/borrow/repay) omit output overrides
        // pending KEEP-296. writeContractCore returns result: undefined, so
        // UI template suggestions are gated in buildOutputFieldsFromAction;
        // named overrides would be dead metadata until the write path decodes
        // function returns.
        supply: {
          slug: "supply",
          label: "Supply Asset",
          description:
            "Supply an asset to the Aave V4 Lido Spoke to earn interest. Amount is in the underlying asset's smallest unit (wei for 18-decimal tokens).",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              helpTip:
                "Opaque uint256 identifier for a reserve within this Spoke. Use the Get Reserve ID action to resolve from (hub, assetId).",
              docUrl: "https://aave.com/docs/aave-v4/liquidity/spokes",
            },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        withdraw: {
          slug: "withdraw",
          label: "Withdraw Asset",
          description: "Withdraw a supplied asset from the Aave V4 Lido Spoke",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/liquidity/spokes",
            },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "Recipient Address" },
          },
        },
        borrow: {
          slug: "borrow",
          label: "Borrow Asset",
          description:
            "Borrow an asset from the Aave V4 Lido Spoke against supplied collateral. V4 uses a single rate model (no stable/variable mode).",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/positions/borrow",
            },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        repay: {
          slug: "repay",
          label: "Repay Debt",
          description: "Repay a borrowed asset to the Aave V4 Lido Spoke",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/positions/borrow",
            },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        setUsingAsCollateral: {
          slug: "set-collateral",
          label: "Set Asset as Collateral",
          description:
            "Enable or disable a supplied reserve as collateral in the Aave V4 Lido Spoke",
          inputs: {
            reserveId: { label: "Reserve ID" },
            usingAsCollateral: {
              label: "Use as Collateral",
              helpTip:
                "Toggles the entire supplied balance of this reserve as collateral. There is no partial collateral in Aave V4.",
              docUrl: "https://aave.com/docs/aave-v4/positions/supply",
            },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        getReserveId: {
          slug: "get-reserve-id",
          label: "Get Reserve ID",
          description:
            "Resolve an asset to its reserveId within this Spoke, given the Hub address and the Hub's assetId for that asset",
          inputs: {
            hub: { label: "Hub Address" },
            assetId: {
              label: "Hub Asset ID",
              helpTip:
                "Asset identifier within the Hub. Use the Hub's getAssetId(underlying) to resolve from an ERC-20 address.",
              docUrl: "https://aave.com/docs/aave-v4/liquidity/spokes",
            },
          },
          outputs: {
            result: {
              name: "reserveId",
              label: "Reserve ID",
            },
          },
        },
        getUserSuppliedAssets: {
          slug: "get-user-supplied-assets",
          label: "Get User Supplied Assets",
          description:
            "Get the amount of underlying asset supplied by a user for a given reserve",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/positions/supply",
            },
            user: { label: "User Address" },
          },
          outputs: {
            result: {
              name: "suppliedAmount",
              label: "Supplied Amount (underlying)",
            },
          },
        },
        getUserDebt: {
          slug: "get-user-debt",
          label: "Get User Debt",
          description:
            "Get the debt of a user for a given reserve, split into drawn debt and premium debt. Total debt = drawn + premium.",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/positions/borrow",
            },
            user: { label: "User Address" },
          },
          outputs: {
            result0: {
              name: "drawnDebt",
              label: "Drawn Debt (underlying)",
            },
            result1: {
              name: "premiumDebt",
              label: "Premium Debt (underlying)",
            },
          },
        },
        getUserAccountData: {
          slug: "get-user-account-data",
          label: "Get User Account Data",
          description:
            "Get overall account health including collateral value, debt, health factor, and risk premium. Returns a struct - access individual fields via dotted path (e.g. result.healthFactor).",
          inputs: {
            user: {
              label: "User Address",
              docUrl: "https://aave.com/docs/aave-v4/positions",
            },
          },
          outputs: {
            result: {
              name: "accountData",
              label:
                "Account Data (struct: riskPremium, avgCollateralFactor, healthFactor, totalCollateralValue, totalDebtValueRay, activeCollateralCount, borrowCount)",
            },
          },
        },
      },
    },
  },
});
