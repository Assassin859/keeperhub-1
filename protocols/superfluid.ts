import { defineAbiProtocol } from "@/lib/protocol-registry";
import { amount, type ProtocolTestData, wallet } from "@/lib/test-data/types";

// KEEP-458 protocol-coverage test data. Sepolia uses the canonical fUSDC /
// fUSDCx pair (matches tests/integration/protocol-superfluid-onchain.test.ts).
// The fUSDC ERC20 exposes a permissionless `mint(to, amount)`; the funder
// calls it in the TS preflight (FAUCETS entry in chain-test-data.ts).
const TEST_DATA: ProtocolTestData = {
  "11155111": {
    setup: {
      minNativeHuman: "0.001",
      // 10 FUSDC wrapped to FUSDCX in setup + headroom for per-test wraps.
      requiredTokens: [{ symbol: "FUSDC", human: "20" }],
      approvals: [
        // Wrap requires the SuperToken (FUSDCX) to spend underlying FUSDC.
        { token: "FUSDC", spender: "FUSDCX", human: "20" },
      ],
      protocolSteps: [
        {
          protocol: "superfluid",
          action: "wrap",
          inputs: {
            contractAddress: "FUSDCX",
            amount: amount("FUSDC", "10"),
          },
        },
      ],
    },
    // GDA pool actions reference a zero-address placeholder pool (we don't
    // capture the create-pool tx receipt to extract the deployed address in
    // Phase 1). Skip on-chain execution; the seeder still surfaces them in
    // the dashboard for discoverability.
    skipped: {
      "update-member-units": "pool dependency; needs real pool address",
      distribute: "pool dependency; needs real pool address",
      "distribute-flow": "pool dependency; needs real pool address",
      "connect-pool": "pool dependency; needs real pool address",
      // These two touch contracts the setup workflow does not warm (the
      // GDA forwarder, and the CFA flow-operator storage). On the CI
      // anvil fork, first-touch state fetches through the throttled
      // public upstream take ~200s per contract (measured 2026-07-02),
      // exceeding the fixture timeout; the CFA flow actions pass because
      // setup warms that contract. Unlock with an archive-grade
      // ANVIL_FORK_SEPOLIA_URL upstream, then remove these skips.
      "grant-flow-operator":
        "cold-contract state fetch exceeds fixture timeout on the public fork upstream",
      "create-pool":
        "cold-contract state fetch exceeds fixture timeout on the public fork upstream",
    },
    actions: {
      // Reads
      "get-flow": {
        token: "FUSDCX",
        sender: wallet(),
        receiver: wallet(),
      },
      // superToken contract is userSpecifiedAddress: pass `contractAddress`.
      "get-super-token-balance": {
        contractAddress: "FUSDCX",
        account: wallet(),
      },
      "get-underlying-token": { contractAddress: "FUSDCX" },
      "get-cfa-net-flow": {
        token: "FUSDCX",
        account: wallet(),
      },
      "get-net-flow": {
        token: "FUSDCX",
        account: wallet(),
      },
      // Writes -- wallet -> burn address. Superfluid CFA reverts with
      // CFA_NO_SELF_FLOW (0xa47338ef) when sender == receiver, so self-streams
      // aren't usable. 0x...dEaD is a stable, contract-free sink: streaming a
      // few wei/sec there costs only the SuperToken buffer (~14400 wei at
      // flowRate=1). Sender stays as the test wallet so create/update/delete
      // operate on the same flow row.
      "create-flow": {
        token: "FUSDCX",
        sender: wallet(),
        receiver: "0x000000000000000000000000000000000000dEaD",
        flowRate: "1",
        userData: "0x",
      },
      "update-flow": {
        token: "FUSDCX",
        sender: wallet(),
        receiver: "0x000000000000000000000000000000000000dEaD",
        flowRate: "2",
        userData: "0x",
      },
      "delete-flow": {
        token: "FUSDCX",
        sender: wallet(),
        receiver: "0x000000000000000000000000000000000000dEaD",
        userData: "0x",
      },
      // SuperToken is userSpecifiedAddress: pass contractAddress explicitly.
      wrap: {
        contractAddress: "FUSDCX",
        amount: amount("FUSDC", "1"),
      },
      unwrap: {
        contractAddress: "FUSDCX",
        amount: amount("FUSDCX", "1"),
      },
      // GDA pool actions. No pool is provisioned in Phase 1, so the `pool`
      // address is the zero placeholder -- the seeded workflow loads but
      // on-chain execution reverts until a pool is created (a setup step
      // for a future iteration).
      "create-pool": {
        token: "FUSDCX",
        admin: wallet(),
        // bools transferabilityForUnitsOwner / distributionFromAnyAddress
        // have `default: "false"` in the protocol def; the resolver picks
        // those up automatically.
      },
      "update-member-units": {
        pool: "0x0000000000000000000000000000000000000000",
        member: wallet(),
        units: "1",
        userData: "0x",
      },
      distribute: {
        token: "FUSDCX",
        from: wallet(),
        pool: "0x0000000000000000000000000000000000000000",
        amount: amount("FUSDCX", "1"),
        userData: "0x",
      },
      "distribute-flow": {
        token: "FUSDCX",
        from: wallet(),
        pool: "0x0000000000000000000000000000000000000000",
        flowRate: "1",
        userData: "0x",
      },
      "connect-pool": {
        pool: "0x0000000000000000000000000000000000000000",
        userData: "0x",
      },
      // CFA flow-operator permissions: grant the burn address full permissions
      // on FUSDCX. Self-operator (flowOperator == msg.sender) reverts with a
      // CFA forwarder ACL custom error; using a stable sink address sidesteps
      // it without affecting any real account.
      "grant-flow-operator": {
        token: "FUSDCX",
        flowOperator: "0x000000000000000000000000000000000000dEaD",
        permissions: "7", // CREATE | UPDATE | DELETE = 1 | 2 | 4
        flowRateAllowance: "1",
      },
    },
  },
};

/**
 * Chain IDs (as strings, matching ProtocolContract.addresses keys) where the
 * Superfluid CFAv1 and GDAv1 forwarders are deployed.
 *
 * Adding a chain: append its ID here. Both forwarders pick it up automatically
 * via sameOnAllChains() because Superfluid pins both forwarders to identical
 * addresses on every chain currently in SUPERFLUID_CHAIN_IDS. This is NOT
 * universal across all chains Superfluid supports -- Avalanche Fuji (43113)
 * uses a different CFAv1Forwarder address. The unit test in
 * tests/unit/superfluid-protocol.test.ts cross-checks every chain here
 * against @superfluid-finance/metadata and will fail if a chain whose
 * forwarders deviate is added without replacing sameOnAllChains() with a
 * per-chain map.
 */
export const SUPERFLUID_CHAIN_IDS = [
  "1", // Ethereum Mainnet
  "10", // Optimism
  "56", // BNB Smart Chain
  "137", // Polygon
  "8453", // Base
  "42161", // Arbitrum One
  "43114", // Avalanche C-Chain
  "11155111", // Sepolia
] as const;

/**
 * Build the per-chain address map for a contract that's deployed at the same
 * address on every chain in SUPERFLUID_CHAIN_IDS. Both forwarders use this --
 * Superfluid intentionally pins them to identical addresses cross-chain.
 */
function sameOnAllChains(address: string): Record<string, string> {
  return Object.fromEntries(SUPERFLUID_CHAIN_IDS.map((id) => [id, address]));
}

const FLOW_RATE_HELP =
  "Wei per second (int96). 1 USDCx/month is approximately 385,802,469,135 wei/s at 18 decimals. Computed: amount * 10^decimals / seconds.";

const CREATE_FLOW_RATE_HELP = `${FLOW_RATE_HELP} Sender needs at least ~3 hours of stream value as a deposit; verify with get-super-token-balance before opening the stream.`;

/**
 * CFAv1Forwarder address. Pinned identical across every chain in
 * SUPERFLUID_CHAIN_IDS by Superfluid's deployment design.
 */
export const CFA_FORWARDER_ADDRESS =
  "0xcfA132E353cB4E398080B9700609bb008eceB125";

// Write functions return bool success. Strip outputs to avoid deriving a
// spurious "Result" output field -- the current action schema has no outputs
// on CFA/GDA write actions.
const CFA_FORWARDER_ABI = JSON.stringify([
  {
    type: "function",
    name: "createFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
      { name: "flowRate", type: "int96" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
      { name: "flowRate", type: "int96" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "deleteFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getFlowInfo",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
    ],
    outputs: [
      { name: "lastUpdated", type: "uint256" },
      { name: "flowRate", type: "int96" },
      { name: "deposit", type: "uint256" },
      { name: "owedDeposit", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getAccountFlowrate",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "int96" }],
  },
  {
    type: "function",
    name: "updateFlowOperatorPermissions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "flowOperator", type: "address" },
      { name: "permissions", type: "uint8" },
      { name: "flowRateAllowance", type: "int96" },
    ],
    outputs: [],
  },
]);

/**
 * GDAv1Forwarder address. Pinned identical across every chain in
 * SUPERFLUID_CHAIN_IDS by Superfluid's deployment design.
 */
export const GDA_FORWARDER_ADDRESS =
  "0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08";

// createPool returns (bool success, address pool) on-chain. Strip outputs to
// match the current action schema which shows no outputs for write actions.
const GDA_FORWARDER_ABI = JSON.stringify([
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "admin", type: "address" },
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "transferabilityForUnitsOwner", type: "bool" },
          { name: "distributionFromAnyAddress", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateMemberUnits",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "member", type: "address" },
      { name: "units", type: "uint128" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "pool", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "distributeFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "pool", type: "address" },
      { name: "flowRate", type: "int96" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "connectPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getNetFlow",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "int96" }],
  },
]);

const SUPER_TOKEN_ABI = JSON.stringify([
  {
    type: "function",
    name: "upgrade",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "downgrade",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
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
    name: "getUnderlyingToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
]);

// KEEP-458: the protocol-coverage test runner executes write actions in
// the order they appear in the ABI per contract, then contracts in the order
// they appear in `contracts`. The critical ordering constraints:
//   - update-flow MUST follow create-flow (cfaForwarder: createFlow before updateFlow)
//   - delete-flow MUST follow create-flow (cfaForwarder: createFlow before deleteFlow)
//   - wrap / unwrap operate on the SuperToken balance and are independent
//   - grant-flow-operator is independent
//   - GDA pool actions (create-pool/update-member-units/distribute/
//     distribute-flow/connect-pool) are in `skipped` so ordering doesn't
//     affect on-chain state.
export default defineAbiProtocol({
  name: "Superfluid",
  slug: "superfluid",
  description:
    "Programmable streaming payments: open per-second money streams between addresses, distribute pro-rata to pool members, and wrap/unwrap SuperTokens",
  website: "https://superfluid.org",
  icon: "/protocols/superfluid.png",

  contracts: {
    cfaForwarder: {
      label: "Superfluid CFAv1 Forwarder",
      abi: CFA_FORWARDER_ABI,
      addresses: sameOnAllChains(CFA_FORWARDER_ADDRESS),
      overrides: {
        createFlow: {
          label: "Open Money Stream",
          description:
            "Open a continuous wei/sec stream of a SuperToken from sender to receiver",
          inputs: {
            token: { label: "SuperToken Address" },
            sender: { label: "Sender Address" },
            receiver: { label: "Receiver Address" },
            flowRate: {
              label: "Flow Rate (wei/sec)",
              helpTip: CREATE_FLOW_RATE_HELP,
            },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        updateFlow: {
          label: "Update Stream Rate",
          description:
            "Change the wei/sec rate of an existing stream. Use delete-flow to close a stream instead of setting rate to 0.",
          inputs: {
            token: { label: "SuperToken Address" },
            sender: { label: "Sender Address" },
            receiver: { label: "Receiver Address" },
            flowRate: {
              label: "New Flow Rate (wei/sec)",
              helpTip: FLOW_RATE_HELP,
            },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        deleteFlow: {
          label: "Close Money Stream",
          description: "Close an open stream between sender and receiver",
          inputs: {
            token: { label: "SuperToken Address" },
            sender: { label: "Sender Address" },
            receiver: { label: "Receiver Address" },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        getFlowInfo: {
          slug: "get-flow",
          label: "Read Flow Between Two Addresses",
          description:
            "Read the current flow rate, deposit, and last-updated timestamp for a stream between two addresses",
          inputs: {
            token: { label: "SuperToken Address" },
            sender: { label: "Sender Address" },
            receiver: { label: "Receiver Address" },
          },
          outputs: {
            lastUpdated: { label: "Last Updated (unix seconds)" },
            flowRate: { label: "Flow Rate (wei/sec)" },
            deposit: { label: "Deposit (wei)", decimals: 18 },
            owedDeposit: { label: "Owed Deposit (wei)", decimals: 18 },
          },
        },
        getAccountFlowrate: {
          slug: "get-cfa-net-flow",
          label: "Read CFA Net Flow Rate of an Address",
          description:
            "Read an address's net flow rate from CFA streams only (positive = net receiver, negative = net sender). Excludes GDA pool distributions. Use get-net-flow for the combined CFA+GDA reading.",
          inputs: {
            token: { label: "SuperToken Address" },
            account: { label: "Account Address" },
          },
          outputs: {
            result: {
              name: "flowRate",
              label: "CFA Net Flow Rate (wei/sec, signed)",
            },
          },
        },
        updateFlowOperatorPermissions: {
          slug: "grant-flow-operator",
          label: "Grant Flow-Operator Permissions",
          description:
            "Authorize another address to manage your flows of a SuperToken up to a wei/sec allowance",
          inputs: {
            token: { label: "SuperToken Address" },
            flowOperator: { label: "Flow Operator Address" },
            permissions: {
              label: "Permissions Bitmap",
              helpTip:
                "Bitmask: 1 = create, 2 = update, 4 = delete, 7 = all three. Combine via bitwise OR.",
            },
            flowRateAllowance: {
              label: "Flow Rate Allowance (wei/sec)",
              helpTip: FLOW_RATE_HELP,
            },
          },
        },
      },
    },
    gdaForwarder: {
      label: "Superfluid GDAv1 Forwarder",
      abi: GDA_FORWARDER_ABI,
      addresses: sameOnAllChains(GDA_FORWARDER_ADDRESS),
      overrides: {
        createPool: {
          label: "Create Distribution Pool",
          description:
            "Create a GDA distribution pool with the supplied address as administrator. The new pool address is emitted in the PoolCreated event. Chain a web3.query-events call after this action filtered by the returned tx hash to capture it.",
          inputs: {
            token: { label: "SuperToken Address" },
            admin: { label: "Pool Admin Address" },
            transferabilityForUnitsOwner: {
              label: "Transferability For Units Owner",
              default: "false",
              helpTip:
                "If true, members can transfer their pool units to other addresses. Most pools leave this false.",
            },
            distributionFromAnyAddress: {
              label: "Distribution From Any Address",
              default: "false",
              helpTip:
                "If true, any address can call distribute/distributeFlow into this pool. If false, only the pool admin can. Most pools leave this false.",
            },
          },
        },
        updateMemberUnits: {
          label: "Set Member Units in a Pool",
          description:
            "Set a recipient's pro-rata share in a distribution pool. New members must call connect-pool from their own wallet before they receive distributions.",
          inputs: {
            pool: { label: "Pool Address" },
            member: { label: "Member Address" },
            units: { label: "Units" },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        distribute: {
          label: "Instant Distribution to a Pool",
          description:
            "Push a one-shot distribution into a pool. Amount divides pro-rata across members by their unit share.",
          inputs: {
            token: { label: "SuperToken Address" },
            from: { label: "Sender Address" },
            pool: { label: "Pool Address" },
            amount: { label: "Amount (wei)" },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        distributeFlow: {
          label: "Stream Into a Pool",
          description:
            "Open a continuous stream into a pool. Members receive their pro-rata share by the second; updating member units changes the split in real time.",
          inputs: {
            token: { label: "SuperToken Address" },
            from: { label: "Sender Address" },
            pool: { label: "Pool Address" },
            flowRate: {
              label: "Flow Rate (wei/sec)",
              helpTip: FLOW_RATE_HELP,
            },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        connectPool: {
          label: "Connect to a Pool (Member Opt-In)",
          description:
            "Members must call this from their own wallet to start receiving distributions. Without this, units exist but no money flows.",
          inputs: {
            pool: { label: "Pool Address" },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        getNetFlow: {
          label: "Read Net Flow Rate of an Address",
          description:
            "Read an address's net flow rate for a SuperToken, combining CFA streams and GDA pool distributions (positive = net receiver, negative = net sender). Use get-cfa-net-flow if you need CFA-only.",
          inputs: {
            token: { label: "SuperToken Address" },
            account: { label: "Account Address" },
          },
          outputs: {
            result: {
              name: "flowRate",
              label: "Net Flow Rate (wei/sec, signed)",
            },
          },
        },
      },
    },
    superToken: {
      label: "Superfluid SuperToken",
      abi: SUPER_TOKEN_ABI,
      addresses: {},
      userSpecifiedAddress: true,
      overrides: {
        upgrade: {
          slug: "wrap",
          label: "Wrap to SuperToken",
          description:
            "Wrap an underlying ERC-20 amount into its SuperToken. Requires a prior web3.approve-token call against the SuperToken address.",
          inputs: {
            amount: { label: "Amount (wei)" },
          },
        },
        downgrade: {
          slug: "unwrap",
          label: "Unwrap from SuperToken",
          description:
            "Unwrap a SuperToken amount back to its underlying ERC-20",
          inputs: {
            amount: { label: "Amount (wei)" },
          },
        },
        balanceOf: {
          slug: "get-super-token-balance",
          label: "Get SuperToken Balance",
          description: "Read an address's current SuperToken balance",
          inputs: {
            account: { label: "Account Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "Balance (wei)",
              decimals: 18,
            },
          },
        },
        getUnderlyingToken: {
          label: "Get Underlying ERC-20 Address",
          description:
            "Read the underlying ERC-20 address for this SuperToken (the token that gets escrowed when you wrap)",
          outputs: {
            result: {
              name: "underlying",
              label: "Underlying ERC-20 Address",
            },
          },
        },
      },
    },
  },

  testData: TEST_DATA,
});
