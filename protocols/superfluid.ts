import { defineProtocol } from "@/lib/protocol-registry";
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
    },
    actions: {
      // Reads
      "get-flow": {
        token: "FUSDCX",
        sender: wallet(),
        receiver: wallet(),
      },
      "get-account-flow-rate": {
        token: "FUSDCX",
        account: wallet(),
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
      // Writes — wallet -> burn address. Superfluid CFA reverts with
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
 * via sameOnAllChains() because the addresses are deliberately constant across
 * every chain Superfluid supports. To ship a new chain, also add an entry to
 * tests/scripts/verify-superfluid-addresses.ts so the bytecode check covers it.
 */
export const SUPERFLUID_CHAIN_IDS = [
  "1", // Ethereum Mainnet
  "10", // Optimism
  "137", // Polygon
  "8453", // Base
  "42161", // Arbitrum One
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
    outputs: [{ name: "", type: "bool" }],
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
    outputs: [{ name: "", type: "bool" }],
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
    outputs: [{ name: "", type: "bool" }],
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
    outputs: [{ name: "flowRate", type: "int96" }],
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
    outputs: [{ name: "", type: "bool" }],
  },
]);

/**
 * GDAv1Forwarder address. Pinned identical across every chain in
 * SUPERFLUID_CHAIN_IDS by Superfluid's deployment design.
 */
export const GDA_FORWARDER_ADDRESS =
  "0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08";

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
    outputs: [
      { name: "", type: "bool" },
      { name: "pool", type: "address" },
    ],
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
    outputs: [{ name: "", type: "bool" }],
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
    outputs: [{ name: "", type: "bool" }],
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
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "connectPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
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

export default defineProtocol({
  name: "Superfluid",
  slug: "superfluid",
  description:
    "Programmable streaming payments: open per-second money streams between addresses, distribute pro-rata to pool members, and wrap/unwrap SuperTokens",
  website: "https://superfluid.org",
  icon: "/protocols/superfluid.png",

  contracts: {
    cfaForwarder: {
      label: "Superfluid CFAv1 Forwarder",
      addresses: sameOnAllChains(CFA_FORWARDER_ADDRESS),
      abi: CFA_FORWARDER_ABI,
    },
    gdaForwarder: {
      label: "Superfluid GDAv1 Forwarder",
      addresses: sameOnAllChains(GDA_FORWARDER_ADDRESS),
      abi: GDA_FORWARDER_ABI,
    },
    superToken: {
      label: "Superfluid SuperToken",
      addresses: {},
      abi: SUPER_TOKEN_ABI,
      userSpecifiedAddress: true,
    },
  },

  // KEEP-458: the protocol-coverage test runner executes write actions in
  // the order they appear below (`protocol.actions.filter(type==='write')`
  // preserves array order, and vitest within a file runs tests sequentially).
  // Tests share the wallet's on-chain CFA flow + SuperToken balance as a
  // singleton, so order matters:
  //   - update-flow MUST follow create-flow (CFA reverts on update of a
  //     non-existent flow).
  //   - delete-flow MUST follow create-flow (and is fine after update-flow;
  //     update doesn't close the flow).
  //   - wrap / unwrap operate on the SuperToken balance setup provisions
  //     (10 FUSDC wrapped to 10 FUSDCX), so they are independent of each
  //     other and of the flow trio.
  //   - grant-flow-operator is independent.
  //   - GDA pool actions (create-pool/update-member-units/distribute/
  //     distribute-flow/connect-pool) are listed in `skipped` above because
  //     Phase 1 setup doesn't capture the deployed pool address; reordering
  //     them does not affect on-chain state.
  // Reordering this array (e.g. alphabetising) will silently break the suite.
  actions: [
    {
      slug: "create-flow",
      label: "Open Money Stream",
      description:
        "Open a continuous wei/sec stream of a SuperToken from sender to receiver",
      type: "write",
      contract: "cfaForwarder",
      function: "createFlow",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "sender", type: "address", label: "Sender Address" },
        { name: "receiver", type: "address", label: "Receiver Address" },
        {
          name: "flowRate",
          type: "int96",
          label: "Flow Rate (wei/sec)",
          helpTip: CREATE_FLOW_RATE_HELP,
        },
        {
          name: "userData",
          type: "bytes",
          label: "User Data",
          default: "0x",
          advanced: true,
        },
      ],
    },
    {
      slug: "update-flow",
      label: "Update Stream Rate",
      description:
        "Change the wei/sec rate of an existing stream. Use delete-flow to close a stream instead of setting rate to 0.",
      type: "write",
      contract: "cfaForwarder",
      function: "updateFlow",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "sender", type: "address", label: "Sender Address" },
        { name: "receiver", type: "address", label: "Receiver Address" },
        {
          name: "flowRate",
          type: "int96",
          label: "New Flow Rate (wei/sec)",
          helpTip: FLOW_RATE_HELP,
        },
        {
          name: "userData",
          type: "bytes",
          label: "User Data",
          default: "0x",
          advanced: true,
        },
      ],
    },
    {
      slug: "delete-flow",
      label: "Close Money Stream",
      description: "Close an open stream between sender and receiver",
      type: "write",
      contract: "cfaForwarder",
      function: "deleteFlow",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "sender", type: "address", label: "Sender Address" },
        { name: "receiver", type: "address", label: "Receiver Address" },
        {
          name: "userData",
          type: "bytes",
          label: "User Data",
          default: "0x",
          advanced: true,
        },
      ],
    },
    {
      slug: "get-flow",
      label: "Read Flow Between Two Addresses",
      description:
        "Read the current flow rate, deposit, and last-updated timestamp for a stream between two addresses",
      type: "read",
      contract: "cfaForwarder",
      function: "getFlowInfo",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "sender", type: "address", label: "Sender Address" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
      outputs: [
        {
          name: "lastUpdated",
          type: "uint256",
          label: "Last Updated (unix seconds)",
        },
        {
          name: "flowRate",
          type: "int96",
          label: "Flow Rate (wei/sec)",
        },
        {
          name: "deposit",
          type: "uint256",
          label: "Deposit (wei)",
          decimals: 18,
        },
        {
          name: "owedDeposit",
          type: "uint256",
          label: "Owed Deposit (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-cfa-net-flow",
      label: "Read CFA Net Flow Rate of an Address",
      description:
        "Read an address's net flow rate from CFA streams only (positive = net receiver, negative = net sender). Excludes GDA pool distributions. Use get-net-flow for the combined CFA+GDA reading.",
      type: "read",
      contract: "cfaForwarder",
      function: "getAccountFlowrate",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "account", type: "address", label: "Account Address" },
      ],
      outputs: [
        {
          name: "flowRate",
          type: "int96",
          label: "CFA Net Flow Rate (wei/sec, signed)",
        },
      ],
    },
    {
      slug: "get-net-flow",
      label: "Read Net Flow Rate of an Address",
      description:
        "Read an address's net flow rate for a SuperToken, combining CFA streams and GDA pool distributions (positive = net receiver, negative = net sender). Use get-cfa-net-flow if you need CFA-only.",
      type: "read",
      contract: "gdaForwarder",
      function: "getNetFlow",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "account", type: "address", label: "Account Address" },
      ],
      outputs: [
        {
          name: "flowRate",
          type: "int96",
          label: "Net Flow Rate (wei/sec, signed)",
        },
      ],
    },
    {
      slug: "create-pool",
      label: "Create Distribution Pool",
      description:
        "Create a GDA distribution pool with the supplied address as administrator. The new pool address is emitted in the PoolCreated event. Chain a web3.query-events call after this action filtered by the returned tx hash to capture it.",
      type: "write",
      contract: "gdaForwarder",
      function: "createPool",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "admin", type: "address", label: "Pool Admin Address" },
        {
          name: "transferabilityForUnitsOwner",
          type: "bool",
          label: "Transferability For Units Owner",
          default: "false",
          helpTip:
            "If true, members can transfer their pool units to other addresses. Most pools leave this false.",
        },
        {
          name: "distributionFromAnyAddress",
          type: "bool",
          label: "Distribution From Any Address",
          default: "false",
          helpTip:
            "If true, any address can call distribute/distributeFlow into this pool. If false, only the pool admin can. Most pools leave this false.",
        },
      ],
    },
    {
      slug: "update-member-units",
      label: "Set Member Units in a Pool",
      description:
        "Set a recipient's pro-rata share in a distribution pool. New members must call connect-pool from their own wallet before they receive distributions.",
      type: "write",
      contract: "gdaForwarder",
      function: "updateMemberUnits",
      inputs: [
        { name: "pool", type: "address", label: "Pool Address" },
        { name: "member", type: "address", label: "Member Address" },
        { name: "units", type: "uint128", label: "Units" },
        {
          name: "userData",
          type: "bytes",
          label: "User Data",
          default: "0x",
          advanced: true,
        },
      ],
    },
    {
      slug: "distribute",
      label: "Instant Distribution to a Pool",
      description:
        "Push a one-shot distribution into a pool. Amount divides pro-rata across members by their unit share.",
      type: "write",
      contract: "gdaForwarder",
      function: "distribute",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "from", type: "address", label: "Sender Address" },
        { name: "pool", type: "address", label: "Pool Address" },
        { name: "amount", type: "uint256", label: "Amount (wei)" },
        {
          name: "userData",
          type: "bytes",
          label: "User Data",
          default: "0x",
          advanced: true,
        },
      ],
    },
    {
      slug: "distribute-flow",
      label: "Stream Into a Pool",
      description:
        "Open a continuous stream into a pool. Members receive their pro-rata share by the second; updating member units changes the split in real time.",
      type: "write",
      contract: "gdaForwarder",
      function: "distributeFlow",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        { name: "from", type: "address", label: "Sender Address" },
        { name: "pool", type: "address", label: "Pool Address" },
        {
          name: "flowRate",
          type: "int96",
          label: "Flow Rate (wei/sec)",
          helpTip: FLOW_RATE_HELP,
        },
        {
          name: "userData",
          type: "bytes",
          label: "User Data",
          default: "0x",
          advanced: true,
        },
      ],
    },
    {
      slug: "connect-pool",
      label: "Connect to a Pool (Member Opt-In)",
      description:
        "Members must call this from their own wallet to start receiving distributions. Without this, units exist but no money flows.",
      type: "write",
      contract: "gdaForwarder",
      function: "connectPool",
      inputs: [
        { name: "pool", type: "address", label: "Pool Address" },
        {
          name: "userData",
          type: "bytes",
          label: "User Data",
          default: "0x",
          advanced: true,
        },
      ],
    },
    {
      slug: "wrap",
      label: "Wrap to SuperToken",
      description:
        "Wrap an underlying ERC-20 amount into its SuperToken. Requires a prior web3.approve-token call against the SuperToken address.",
      type: "write",
      contract: "superToken",
      function: "upgrade",
      inputs: [{ name: "amount", type: "uint256", label: "Amount (wei)" }],
    },
    {
      slug: "unwrap",
      label: "Unwrap from SuperToken",
      description: "Unwrap a SuperToken amount back to its underlying ERC-20",
      type: "write",
      contract: "superToken",
      function: "downgrade",
      inputs: [{ name: "amount", type: "uint256", label: "Amount (wei)" }],
    },
    {
      slug: "grant-flow-operator",
      label: "Grant Flow-Operator Permissions",
      description:
        "Authorize another address to manage your flows of a SuperToken up to a wei/sec allowance",
      type: "write",
      contract: "cfaForwarder",
      function: "updateFlowOperatorPermissions",
      inputs: [
        { name: "token", type: "address", label: "SuperToken Address" },
        {
          name: "flowOperator",
          type: "address",
          label: "Flow Operator Address",
        },
        {
          name: "permissions",
          type: "uint8",
          label: "Permissions Bitmap",
          helpTip:
            "Bitmask: 1 = create, 2 = update, 4 = delete, 7 = all three. Combine via bitwise OR.",
        },
        {
          name: "flowRateAllowance",
          type: "int96",
          label: "Flow Rate Allowance (wei/sec)",
          helpTip: FLOW_RATE_HELP,
        },
      ],
    },
    {
      slug: "get-super-token-balance",
      label: "Get SuperToken Balance",
      description: "Read an address's current SuperToken balance",
      type: "read",
      contract: "superToken",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Account Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "Balance (wei)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-underlying-token",
      label: "Get Underlying ERC-20 Address",
      description:
        "Read the underlying ERC-20 address for this SuperToken (the token that gets escrowed when you wrap)",
      type: "read",
      contract: "superToken",
      function: "getUnderlyingToken",
      inputs: [],
      outputs: [
        {
          name: "underlying",
          type: "address",
          label: "Underlying ERC-20 Address",
        },
      ],
    },
  ],

  testData: TEST_DATA,
});
