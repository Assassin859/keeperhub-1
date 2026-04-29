import { defineAbiProtocol } from "@/lib/protocol-registry";
import factoryAbi from "./abis/uniswap-factory.json";
import positionManagerAbi from "./abis/uniswap-position-manager.json";
import quoterAbi from "./abis/uniswap-quoter.json";
import swapRouterAbi from "./abis/uniswap-swap-router.json";

const UNISWAP_DOCS = "https://developers.uniswap.org/docs/protocols/v3/overview";

const FEE_TIER_TIP =
  "Pool fee tier in hundredths of a basis point. Common values: 100 (0.01% - stablecoin pairs), 500 (0.05% - correlated pairs), 3000 (0.3% - most pairs), 10000 (1% - exotic pairs).";

const SQRT_PRICE_LIMIT_TIP =
  "Square-root price limit encoded as a Q64.96 fixed-point number. Constrains how far the pool price can move during the swap. Set to 0 for no limit (most common). Non-zero values act as a slippage guard at the pool level.";

const POSITION_TOKEN_ID_TIP =
  "The NFT token ID representing a Uniswap V3 liquidity position. Each position minted via the NonfungiblePositionManager receives a unique uint256 ID. Find it from the Mint event or via the balanceOf + tokenOfOwnerByIndex pattern.";

// QuoterV2 is declared as `view` in the reduced ABI even though the on-chain
// contract is `nonpayable`. QuoterV2 uses a revert-to-return pattern (calls
// pool.swap inside a try/catch), so the true mutability is nonpayable, but
// every client invokes these via eth_call. Declaring `view` keeps the action
// classified as a read step - no credentials, no gas, no state change.
//
// SwapRouter02 and NonfungiblePositionManager have several `payable` functions
// upstream (exactInputSingle, exactOutputSingle, burn) to support multicall
// composition. They are marked `nonpayable` in the reduced ABI because we do
// not expose the ETH-value path through these actions; callers wrap ETH via
// the WETH protocol first.

export default defineAbiProtocol({
  name: "Uniswap V3",
  slug: "uniswap",
  description:
    "Uniswap V3 - pool discovery, liquidity positions, swaps, and quotes",
  website: "https://uniswap.org",
  icon: "/protocols/uniswap.png",

  contracts: {
    factory: {
      label: "Uniswap V3 Factory",
      abi: JSON.stringify(factoryAbi),
      addresses: {
        "1": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "8453": "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        "42161": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "10": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "11155111": "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
      },
      overrides: {
        getPool: {
          slug: "get-pool",
          label: "Get Pool Address",
          description:
            "Find the Uniswap V3 pool address for a token pair and fee tier",
          inputs: {
            tokenA: { label: "Token A Address" },
            tokenB: { label: "Token B Address" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            pool: { label: "Pool Address" },
          },
        },
      },
    },
    positionManager: {
      label: "NonfungiblePositionManager",
      abi: JSON.stringify(positionManagerAbi),
      addresses: {
        "1": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
        "8453": "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
        "42161": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
        "10": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
        "11155111": "0x1238536071E1c677A632429e3655c799b22cDA52",
      },
      overrides: {
        positions: {
          slug: "get-position",
          label: "Get Position Details",
          description:
            "Get full details of a liquidity position by NFT token ID",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            nonce: { label: "Nonce" },
            operator: { label: "Operator Address" },
            token0: { label: "Token 0 Address" },
            token1: { label: "Token 1 Address" },
            fee: { label: "Fee Tier" },
            tickLower: { label: "Lower Tick" },
            tickUpper: { label: "Upper Tick" },
            liquidity: { label: "Liquidity" },
            feeGrowthInside0LastX128: { label: "Fee Growth Inside 0 (X128)" },
            feeGrowthInside1LastX128: { label: "Fee Growth Inside 1 (X128)" },
            tokensOwed0: { label: "Tokens Owed 0" },
            tokensOwed1: { label: "Tokens Owed 1" },
          },
        },
        balanceOf: {
          slug: "balance-of",
          label: "Get Position Count",
          description: "Check how many LP position NFTs an address owns",
          inputs: {
            owner: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "Position Count" },
          },
        },
        ownerOf: {
          slug: "owner-of",
          label: "Get Position Owner",
          description: "Get the owner address of a liquidity position NFT",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            result: { name: "owner", label: "Owner Address" },
          },
        },
        approve: {
          slug: "approve-position",
          label: "Approve Position Transfer",
          description:
            "Approve an address to manage a specific liquidity position NFT",
          inputs: {
            to: { label: "Approved Address" },
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
        },
        transferFrom: {
          slug: "transfer-position",
          label: "Transfer Position NFT",
          description: "Transfer a liquidity position NFT to another address",
          inputs: {
            from: { label: "From Address" },
            to: { label: "To Address" },
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
        },
        burn: {
          slug: "burn-position",
          label: "Burn Empty Position",
          description:
            "Burn an empty liquidity position NFT (position must have zero liquidity and zero owed tokens)",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
        },
      },
    },
    swapRouter: {
      label: "SwapRouter02",
      abi: JSON.stringify(swapRouterAbi),
      addresses: {
        "1": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        "8453": "0x2626664c2603336E57B271c5C0b26F421741e481",
        "42161": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        "10": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        "11155111": "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
      },
      overrides: {
        exactInputSingle: {
          slug: "swap-exact-input",
          label: "Swap Exact Input",
          description:
            "Swap an exact amount of input tokens for as many output tokens as possible (single-hop)",
          inputs: {
            tokenIn: { label: "Input Token Address" },
            tokenOut: { label: "Output Token Address" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
            recipient: { label: "Recipient Address" },
            amountIn: { label: "Amount In (wei)" },
            amountOutMinimum: {
              label: "Minimum Output Amount (wei)",
              helpTip:
                "Minimum tokens to receive after the swap. The transaction reverts if the output would be less. Set to 0 only for testing - in production, calculate from a quote minus your slippage tolerance to avoid sandwich attacks.",
              docUrl: UNISWAP_DOCS,
            },
            sqrtPriceLimitX96: {
              label: "Price Limit (0 for none)",
              default: "0",
              helpTip: SQRT_PRICE_LIMIT_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amountOut: { label: "Amount Out (wei)" },
          },
        },
        exactOutputSingle: {
          slug: "swap-exact-output",
          label: "Swap Exact Output",
          description:
            "Swap as few input tokens as possible for an exact amount of output tokens (single-hop)",
          inputs: {
            tokenIn: { label: "Input Token Address" },
            tokenOut: { label: "Output Token Address" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
            recipient: { label: "Recipient Address" },
            amountOut: { label: "Desired Output Amount (wei)" },
            amountInMaximum: {
              label: "Maximum Input Amount (wei)",
              helpTip:
                "Maximum tokens you are willing to spend. The transaction reverts if the required input exceeds this. Calculate from a quote plus your slippage tolerance.",
              docUrl: UNISWAP_DOCS,
            },
            sqrtPriceLimitX96: {
              label: "Price Limit (0 for none)",
              default: "0",
              helpTip: SQRT_PRICE_LIMIT_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amountIn: { label: "Amount In (wei)" },
          },
        },
      },
    },
    quoter: {
      label: "QuoterV2",
      abi: JSON.stringify(quoterAbi),
      addresses: {
        "1": "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        "8453": "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        "42161": "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        "10": "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        "11155111": "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
      },
      overrides: {
        quoteExactInputSingle: {
          slug: "quote-exact-input",
          label: "Quote Exact Input",
          description:
            "Get the expected output amount for a single-hop exact-input swap",
          inputs: {
            tokenIn: { label: "Input Token Address" },
            tokenOut: { label: "Output Token Address" },
            amountIn: { label: "Amount In (wei)" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
            sqrtPriceLimitX96: {
              label: "Price Limit (0 for none)",
              default: "0",
              helpTip: SQRT_PRICE_LIMIT_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amountOut: { label: "Amount Out (wei)" },
            sqrtPriceX96After: { label: "Price After Swap" },
            initializedTicksCrossed: { label: "Ticks Crossed" },
            gasEstimate: { label: "Gas Estimate" },
          },
        },
        quoteExactOutputSingle: {
          slug: "quote-exact-output",
          label: "Quote Exact Output",
          description:
            "Get the required input amount for a single-hop exact-output swap",
          inputs: {
            tokenIn: { label: "Input Token Address" },
            tokenOut: { label: "Output Token Address" },
            amount: { label: "Desired Output Amount (wei)" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
            sqrtPriceLimitX96: {
              label: "Price Limit (0 for none)",
              default: "0",
              helpTip: SQRT_PRICE_LIMIT_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amountIn: { label: "Amount In (wei)" },
            sqrtPriceX96After: { label: "Price After Swap" },
            initializedTicksCrossed: { label: "Ticks Crossed" },
            gasEstimate: { label: "Gas Estimate" },
          },
        },
      },
    },
  },
});
