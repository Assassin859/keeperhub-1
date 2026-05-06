import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: "Aerodrome",
  slug: "aerodrome",
  description:
    "Aerodrome Finance: the leading DEX on Base with volatile/stable pools, ve(3,3) voting, and gauge-based emissions",
  website: "https://aerodrome.finance",
  icon: "/protocols/aerodrome.png",

  contracts: {
    router: {
      label: "Aerodrome Router",
      addresses: {
        // Base
        "8453": "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
      },
      // Inline ABI -- BaseScan auto-fetch fails for this contract
      abi: JSON.stringify([
        {
          type: "function",
          name: "getReserves",
          stateMutability: "view",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "stable", type: "bool" },
            { name: "factory", type: "address" },
          ],
          outputs: [
            { name: "reserveA", type: "uint256" },
            { name: "reserveB", type: "uint256" },
          ],
        },
        {
          type: "function",
          name: "poolFor",
          stateMutability: "view",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "stable", type: "bool" },
            { name: "factory", type: "address" },
          ],
          outputs: [{ name: "pool", type: "address" }],
        },
        {
          type: "function",
          name: "swapExactTokensForTokens",
          stateMutability: "nonpayable",
          inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "amountOutMin", type: "uint256" },
            {
              name: "routes",
              type: "tuple[]",
              components: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "stable", type: "bool" },
                { name: "factory", type: "address" },
              ],
            },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [{ name: "amounts", type: "uint256[]" }],
        },
        {
          type: "function",
          name: "addLiquidity",
          stateMutability: "nonpayable",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "stable", type: "bool" },
            { name: "amountADesired", type: "uint256" },
            { name: "amountBDesired", type: "uint256" },
            { name: "amountAMin", type: "uint256" },
            { name: "amountBMin", type: "uint256" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [
            { name: "amountA", type: "uint256" },
            { name: "amountB", type: "uint256" },
            { name: "liquidity", type: "uint256" },
          ],
        },
        {
          type: "function",
          name: "removeLiquidity",
          stateMutability: "nonpayable",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "stable", type: "bool" },
            { name: "liquidity", type: "uint256" },
            { name: "amountAMin", type: "uint256" },
            { name: "amountBMin", type: "uint256" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [
            { name: "amountA", type: "uint256" },
            { name: "amountB", type: "uint256" },
          ],
        },
      ]),
    },
    voter: {
      label: "Aerodrome Voter",
      addresses: {
        // Base
        "8453": "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
      },
      // Inline ABI -- BaseScan auto-fetch fails for this contract
      abi: JSON.stringify([
        {
          type: "function",
          name: "totalWeight",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "isAlive",
          stateMutability: "view",
          inputs: [{ name: "_gauge", type: "address" }],
          outputs: [{ name: "", type: "bool" }],
        },
        {
          type: "function",
          name: "gauges",
          stateMutability: "view",
          inputs: [{ name: "_pool", type: "address" }],
          outputs: [{ name: "", type: "address" }],
        },
        {
          type: "function",
          name: "vote",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_tokenId", type: "uint256" },
            { name: "_poolVote", type: "address[]" },
            { name: "_weights", type: "uint256[]" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "reset",
          stateMutability: "nonpayable",
          inputs: [{ name: "_tokenId", type: "uint256" }],
          outputs: [],
        },
        {
          type: "function",
          name: "claimRewards",
          stateMutability: "nonpayable",
          inputs: [{ name: "_gauges", type: "address[]" }],
          outputs: [],
        },
      ]),
    },
    poolFactory: {
      label: "Aerodrome Pool Factory",
      addresses: {
        // Base
        "8453": "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
      },
      // Inline ABI -- BaseScan auto-fetch fails for this contract
      abi: JSON.stringify([
        {
          type: "function",
          name: "allPoolsLength",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
      ]),
    },
    votingEscrow: {
      label: "Aerodrome VotingEscrow (veAERO)",
      addresses: {
        // Base
        "8453": "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4",
      },
      // Inline ABI -- BaseScan auto-fetch fails for this contract
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOfNFT",
          stateMutability: "view",
          inputs: [{ name: "_tokenId", type: "uint256" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "locked",
          stateMutability: "view",
          inputs: [{ name: "_tokenId", type: "uint256" }],
          outputs: [
            { name: "amount", type: "int128" },
            { name: "end", type: "uint256" },
          ],
        },
        {
          type: "function",
          name: "create_lock",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_value", type: "uint256" },
            { name: "_lockDuration", type: "uint256" },
          ],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "increase_amount",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_tokenId", type: "uint256" },
            { name: "_value", type: "uint256" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "increase_unlock_time",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_tokenId", type: "uint256" },
            { name: "_lockDuration", type: "uint256" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [{ name: "_tokenId", type: "uint256" }],
          outputs: [],
        },
      ]),
    },
    pool: {
      label: "Aerodrome Pool",
      addresses: {
        // Base -- reference address (WETH/USDC pool); runtime address comes from user input
        "8453": "0xcDAC0d6c6C59727a65F871236188350531885C43",
      },
      userSpecifiedAddress: true,
      // Inline ABI -- pool-level getAmountOut
      abi: JSON.stringify([
        {
          type: "function",
          name: "getAmountOut",
          stateMutability: "view",
          inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "tokenIn", type: "address" },
          ],
          outputs: [{ name: "", type: "uint256" }],
        },
      ]),
    },
    aeroToken: {
      label: "AERO Token",
      addresses: {
        // Base
        "8453": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      },
      // Inline ABI -- BaseScan auto-fetch fails for this contract
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
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ]),
    },
  },

  actions: [
    // Pool Reads

    {
      slug: "get-reserves",
      label: "Get Pool Reserves",
      description:
        "Get the current reserves for an Aerodrome pool by token pair",
      type: "read",
      contract: "router",
      function: "getReserves",
      inputs: [
        { name: "tokenA", type: "address", label: "Token A Address" },
        { name: "tokenB", type: "address", label: "Token B Address" },
        { name: "stable", type: "bool", label: "Stable Pool (true/false)" },
        {
          name: "factory",
          type: "address",
          label: "Pool Factory Address",
          default: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
        },
      ],
      outputs: [
        {
          name: "reserveA",
          type: "uint256",
          label: "Reserve A (raw wei)",
        },
        {
          name: "reserveB",
          type: "uint256",
          label: "Reserve B (raw wei)",
        },
      ],
    },
    {
      slug: "get-pool-for-pair",
      label: "Get Pool Address",
      description:
        "Resolve the pool address for a token pair and pool type (stable/volatile)",
      type: "read",
      contract: "router",
      function: "poolFor",
      inputs: [
        { name: "tokenA", type: "address", label: "Token A Address" },
        { name: "tokenB", type: "address", label: "Token B Address" },
        { name: "stable", type: "bool", label: "Stable Pool (true/false)" },
        {
          name: "factory",
          type: "address",
          label: "Pool Factory Address",
          default: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
        },
      ],
      outputs: [
        {
          name: "pool",
          type: "address",
          label: "Pool Address",
        },
      ],
    },
    {
      slug: "get-amount-out",
      label: "Get Expected Output",
      description:
        "Get the expected output amount for a swap from a specific Aerodrome pool",
      type: "read",
      contract: "pool",
      function: "getAmountOut",
      inputs: [
        { name: "amountIn", type: "uint256", label: "Input Amount (wei)" },
        { name: "tokenIn", type: "address", label: "Input Token Address" },
      ],
      outputs: [
        {
          name: "amountOut",
          type: "uint256",
          label: "Expected Output (wei)",
        },
      ],
    },
    {
      slug: "get-all-pools-length",
      label: "Get Total Pool Count",
      description:
        "Get the total number of pools created by the Aerodrome factory",
      type: "read",
      contract: "poolFactory",
      function: "allPoolsLength",
      inputs: [],
      outputs: [
        {
          name: "count",
          type: "uint256",
          label: "Total Pool Count",
        },
      ],
    },

    // Voting Reads

    {
      slug: "get-total-weight",
      label: "Get Total Voting Weight",
      description: "Get the total voting weight across all gauges",
      type: "read",
      contract: "voter",
      function: "totalWeight",
      inputs: [],
      outputs: [
        {
          name: "totalWeight",
          type: "uint256",
          label: "Total Weight",
          decimals: 18,
        },
      ],
    },
    {
      slug: "is-gauge-alive",
      label: "Check Gauge Status",
      description: "Check whether a gauge is active and receiving emissions",
      type: "read",
      contract: "voter",
      function: "isAlive",
      inputs: [{ name: "_gauge", type: "address", label: "Gauge Address" }],
      outputs: [{ name: "alive", type: "bool", label: "Is Alive" }],
    },
    {
      slug: "get-gauge-for-pool",
      label: "Get Gauge for Pool",
      description:
        "Look up the gauge address for a pool to check status or vote",
      type: "read",
      contract: "voter",
      function: "gauges",
      inputs: [{ name: "_pool", type: "address", label: "Pool Address" }],
      outputs: [{ name: "gauge", type: "address", label: "Gauge Address" }],
    },

    // veNFT Reads

    {
      slug: "get-venft-balance",
      label: "Get veNFT Voting Power",
      description: "Get the current voting power of a veAERO NFT position",
      type: "read",
      contract: "votingEscrow",
      function: "balanceOfNFT",
      inputs: [
        {
          name: "_tokenId",
          type: "uint256",
          label: "veNFT Token ID",
        },
      ],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "Voting Power",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-lock-details",
      label: "Get Lock Details",
      description:
        "Get the locked AERO amount and unlock timestamp for a veNFT position",
      type: "read",
      contract: "votingEscrow",
      function: "locked",
      inputs: [
        {
          name: "_tokenId",
          type: "uint256",
          label: "veNFT Token ID",
        },
      ],
      outputs: [
        {
          name: "amount",
          type: "int128",
          label: "Locked Amount (raw)",
        },
        {
          name: "end",
          type: "uint256",
          label: "Unlock Timestamp (unix)",
        },
      ],
    },

    // AERO Token Reads

    {
      slug: "aero-balance-of",
      label: "Get AERO Balance",
      description: "Check AERO token balance of an address",
      type: "read",
      contract: "aeroToken",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "AERO Balance",
          decimals: 18,
        },
      ],
    },

    // Write Actions

    {
      slug: "swap-exact-tokens",
      label: "Swap Exact Tokens",
      description:
        "Swap an exact amount of input tokens for as many output tokens as possible via Aerodrome routes",
      type: "write",
      contract: "router",
      function: "swapExactTokensForTokens",
      inputs: [
        { name: "amountIn", type: "uint256", label: "Input Amount (wei)" },
        {
          name: "amountOutMin",
          type: "uint256",
          label: "Minimum Output (wei)",
        },
        {
          name: "routes",
          type: "tuple[]",
          label: "Swap Routes (JSON array of {from, to, stable, factory})",
          helpTip:
            "Each route is an object with from (address), to (address), stable (bool), factory (address). For single-hop swaps use one route entry.",
        },
        { name: "to", type: "address", label: "Recipient Address" },
        {
          name: "deadline",
          type: "uint256",
          label: "Deadline (unix timestamp)",
        },
      ],
    },
    {
      slug: "add-liquidity",
      label: "Add Liquidity",
      description: "Add liquidity to an Aerodrome pool and receive LP tokens",
      type: "write",
      contract: "router",
      function: "addLiquidity",
      inputs: [
        { name: "tokenA", type: "address", label: "Token A Address" },
        { name: "tokenB", type: "address", label: "Token B Address" },
        { name: "stable", type: "bool", label: "Stable Pool (true/false)" },
        {
          name: "amountADesired",
          type: "uint256",
          label: "Desired Amount A (wei)",
        },
        {
          name: "amountBDesired",
          type: "uint256",
          label: "Desired Amount B (wei)",
        },
        {
          name: "amountAMin",
          type: "uint256",
          label: "Minimum Amount A (wei)",
        },
        {
          name: "amountBMin",
          type: "uint256",
          label: "Minimum Amount B (wei)",
        },
        { name: "to", type: "address", label: "Recipient Address" },
        {
          name: "deadline",
          type: "uint256",
          label: "Deadline (unix timestamp)",
        },
      ],
    },
    {
      slug: "remove-liquidity",
      label: "Remove Liquidity",
      description:
        "Remove liquidity from an Aerodrome pool by burning LP tokens",
      type: "write",
      contract: "router",
      function: "removeLiquidity",
      inputs: [
        { name: "tokenA", type: "address", label: "Token A Address" },
        { name: "tokenB", type: "address", label: "Token B Address" },
        { name: "stable", type: "bool", label: "Stable Pool (true/false)" },
        {
          name: "liquidity",
          type: "uint256",
          label: "LP Token Amount (wei)",
        },
        {
          name: "amountAMin",
          type: "uint256",
          label: "Minimum Amount A (wei)",
        },
        {
          name: "amountBMin",
          type: "uint256",
          label: "Minimum Amount B (wei)",
        },
        { name: "to", type: "address", label: "Recipient Address" },
        {
          name: "deadline",
          type: "uint256",
          label: "Deadline (unix timestamp)",
        },
      ],
    },
    {
      slug: "vote",
      label: "Vote on Gauges",
      description: "Cast votes for pool gauges using veAERO voting power",
      type: "write",
      contract: "voter",
      function: "vote",
      inputs: [
        {
          name: "_tokenId",
          type: "uint256",
          label: "veNFT Token ID",
        },
        {
          name: "_poolVote",
          type: "address[]",
          label: "Pool Addresses (comma-separated)",
        },
        {
          name: "_weights",
          type: "uint256[]",
          label: "Vote Weights (comma-separated)",
        },
      ],
    },
    {
      slug: "reset-votes",
      label: "Reset Votes",
      description:
        "Reset all gauge votes for a veNFT, required before changing vote allocations in a new epoch",
      type: "write",
      contract: "voter",
      function: "reset",
      inputs: [
        {
          name: "_tokenId",
          type: "uint256",
          label: "veNFT Token ID",
        },
      ],
    },
    {
      slug: "create-lock",
      label: "Create veAERO Lock",
      description:
        "Lock AERO tokens to create a veAERO NFT position with voting power",
      type: "write",
      contract: "votingEscrow",
      function: "create_lock",
      inputs: [
        {
          name: "_value",
          type: "uint256",
          label: "AERO Amount (wei)",
          decimals: 18,
        },
        {
          name: "_lockDuration",
          type: "uint256",
          label: "Lock Duration (seconds)",
        },
      ],
    },
    {
      slug: "increase-lock-amount",
      label: "Increase Lock Amount",
      description: "Add more AERO tokens to an existing veNFT lock position",
      type: "write",
      contract: "votingEscrow",
      function: "increase_amount",
      inputs: [
        {
          name: "_tokenId",
          type: "uint256",
          label: "veNFT Token ID",
        },
        {
          name: "_value",
          type: "uint256",
          label: "Additional AERO Amount (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "increase-lock-duration",
      label: "Increase Lock Duration",
      description: "Extend the lock duration of an existing veNFT position",
      type: "write",
      contract: "votingEscrow",
      function: "increase_unlock_time",
      inputs: [
        {
          name: "_tokenId",
          type: "uint256",
          label: "veNFT Token ID",
        },
        {
          name: "_lockDuration",
          type: "uint256",
          label: "New Lock Duration (seconds)",
        },
      ],
    },
    {
      slug: "withdraw-lock",
      label: "Withdraw Expired Lock",
      description: "Withdraw AERO tokens from an expired veNFT lock position",
      type: "write",
      contract: "votingEscrow",
      function: "withdraw",
      inputs: [
        {
          name: "_tokenId",
          type: "uint256",
          label: "veNFT Token ID",
        },
      ],
    },
    {
      slug: "claim-rewards",
      label: "Claim Gauge Rewards",
      description: "Claim accumulated AERO rewards from gauges",
      type: "write",
      contract: "voter",
      function: "claimRewards",
      inputs: [
        {
          name: "_gauges",
          type: "address[]",
          label: "Gauge Addresses (comma-separated)",
        },
      ],
    },
    {
      slug: "aero-approve",
      label: "Approve AERO",
      description: "Approve an address to spend AERO tokens",
      type: "write",
      contract: "aeroToken",
      function: "approve",
      inputs: [
        { name: "spender", type: "address", label: "Spender Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
      ],
    },
  ],

  events: [
    // Pool Events

    {
      slug: "pool-swap",
      label: "Pool Swap",
      description: "Fires when a swap occurs in an Aerodrome pool",
      eventName: "Swap",
      contract: "pool",
      inputs: [
        { name: "sender", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "amount0In", type: "uint256", indexed: false },
        { name: "amount1In", type: "uint256", indexed: false },
        { name: "amount0Out", type: "uint256", indexed: false },
        { name: "amount1Out", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "pool-sync",
      label: "Pool Reserves Synced",
      description:
        "Fires when pool reserves are updated after any operation (swap, mint, burn)",
      eventName: "Sync",
      contract: "pool",
      inputs: [
        { name: "reserve0", type: "uint256", indexed: false },
        { name: "reserve1", type: "uint256", indexed: false },
      ],
    },

    // VotingEscrow Events

    {
      slug: "ve-deposit",
      label: "veAERO Deposit",
      description:
        "Fires when AERO tokens are locked or added to a veNFT position",
      eventName: "Deposit",
      contract: "votingEscrow",
      inputs: [
        { name: "provider", type: "address", indexed: true },
        { name: "tokenId", type: "uint256", indexed: true },
        { name: "value", type: "uint256", indexed: false },
        { name: "locktime", type: "uint256", indexed: false },
        { name: "depositType", type: "uint256", indexed: false },
        { name: "ts", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "ve-withdraw",
      label: "veAERO Withdrawal",
      description:
        "Fires when AERO tokens are withdrawn from an expired veNFT lock",
      eventName: "Withdraw",
      contract: "votingEscrow",
      inputs: [
        { name: "provider", type: "address", indexed: true },
        { name: "tokenId", type: "uint256", indexed: true },
        { name: "value", type: "uint256", indexed: false },
        { name: "ts", type: "uint256", indexed: false },
      ],
    },

    // Voter Events

    {
      slug: "voter-voted",
      label: "Gauge Vote Cast",
      description: "Fires when a veNFT holder casts votes for a pool gauge",
      eventName: "Voted",
      contract: "voter",
      inputs: [
        { name: "voter", type: "address", indexed: true },
        { name: "pool", type: "address", indexed: true },
        { name: "tokenId", type: "uint256", indexed: true },
        { name: "weight", type: "uint256", indexed: false },
        { name: "totalWeight", type: "uint256", indexed: false },
        { name: "timestamp", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "gauge-created",
      label: "Gauge Created",
      description: "Fires when a new gauge is created for a pool",
      eventName: "GaugeCreated",
      contract: "voter",
      inputs: [
        { name: "poolFactory", type: "address", indexed: true },
        { name: "votingRewardsFactory", type: "address", indexed: true },
        { name: "gaugeFactory", type: "address", indexed: true },
        { name: "pool", type: "address", indexed: false },
        { name: "bribeVotingReward", type: "address", indexed: false },
        { name: "feeVotingReward", type: "address", indexed: false },
        { name: "gauge", type: "address", indexed: false },
        { name: "creator", type: "address", indexed: false },
      ],
    },
    {
      slug: "distribute-reward",
      label: "Reward Distributed",
      description: "Fires when AERO emissions are distributed to a gauge",
      eventName: "DistributeReward",
      contract: "voter",
      inputs: [
        { name: "sender", type: "address", indexed: true },
        { name: "gauge", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
  ],
});
