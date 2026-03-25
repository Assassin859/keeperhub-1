import type { ProtocolAction } from "@/lib/protocol-registry";
import { defineProtocol } from "@/lib/protocol-registry";

// Chronicle IChronicle ABI -- shared across all oracle contracts.
// Inline because Chronicle oracles may not be verified on all block explorers.
const ORACLE_ABI = JSON.stringify([
  {
    type: "function",
    name: "read",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "tryRead",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "bool" },
      { name: "", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "readWithAge",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "tryReadWithAge",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "bool" },
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
]);

const SELF_KISSER_ABI = JSON.stringify([
  {
    type: "function",
    name: "selfKiss",
    stateMutability: "nonpayable",
    inputs: [{ name: "oracle", type: "address" }],
    outputs: [],
  },
]);

function feedActions(
  feedSlug: string,
  feedLabel: string,
  contractKey: string
): ProtocolAction[] {
  return [
    {
      slug: `${feedSlug}-read`,
      label: `Read ${feedLabel} Value`,
      description: `Read the current ${feedLabel} price from the Chronicle oracle. Caller must be whitelisted (kissed).`,
      type: "read",
      contract: contractKey,
      function: "read",
      inputs: [],
      outputs: [
        {
          name: "value",
          type: "uint256",
          label: "Oracle Value",
          decimals: 18,
        },
      ],
    },
    {
      slug: `${feedSlug}-read-with-age`,
      label: `Read ${feedLabel} Value with Age`,
      description: `Read the current ${feedLabel} price and its last-updated timestamp from the Chronicle oracle.`,
      type: "read",
      contract: contractKey,
      function: "readWithAge",
      inputs: [],
      outputs: [
        {
          name: "value",
          type: "uint256",
          label: "Oracle Value",
          decimals: 18,
        },
        {
          name: "age",
          type: "uint256",
          label: "Last Updated (Unix timestamp)",
        },
      ],
    },
  ];
}

export default defineProtocol({
  name: "Chronicle",
  slug: "chronicle",
  description:
    "Chronicle Protocol -- decentralized, verifiable oracle price feeds with Schnorr signature verification",
  website: "https://chroniclelabs.org",
  icon: "/protocols/chronicle.png",

  contracts: {
    // Named feed contracts -- one-click, no address needed
    ethUsd: {
      label: "ETH/USD Oracle",
      abi: ORACLE_ABI,
      addresses: {
        "1": "0x46ef0071b1E2fF6B42d36e5A177EA43Ae5917f4E",
        "11155111": "0xdd6D76262Fd7BdDe428dcfCd94386EbAe0151603",
      },
    },
    btcUsd: {
      label: "BTC/USD Oracle",
      abi: ORACLE_ABI,
      addresses: {
        "1": "0x24C392CDbF32Cf911B258981a66d5541d85269ce",
        "11155111": "0x6edF073c4Bd934d3916AA6dDAC4255ccB2b7c0f0",
      },
    },
    daiUsd: {
      label: "DAI/USD Oracle",
      abi: ORACLE_ABI,
      addresses: {
        "11155111": "0xaf900d10f197762794C41dac395C5b8112eD13E1",
      },
    },
    usdcUsd: {
      label: "USDC/USD Oracle",
      abi: ORACLE_ABI,
      addresses: {
        "1": "0xCe701340261a3dc3541C5f8A6d2bE689381C8fCC",
        "11155111": "0xb34d784dc8E7cD240Fe1F318e282dFdD13C389AC",
      },
    },
    usdtUsd: {
      label: "USDT/USD Oracle",
      abi: ORACLE_ABI,
      addresses: {
        "1": "0x7084a627a22b2de99E18733DC5aAF40993FA405C",
        "11155111": "0x8c852EEC6ae356FeDf5d7b824E254f7d94Ac6824",
      },
    },
    linkUsd: {
      label: "LINK/USD Oracle",
      abi: ORACLE_ABI,
      addresses: {
        "11155111": "0x260c182f0054BF244a8e38d7C475b6d9f67AeAc1",
      },
    },

    // Custom oracle -- user provides any Chronicle oracle address
    customOracle: {
      label: "Custom Chronicle Oracle",
      userSpecifiedAddress: true,
      abi: ORACLE_ABI,
      // Reference addresses (ETH/USD) for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field.
      addresses: {
        "1": "0x46ef0071b1E2fF6B42d36e5A177EA43Ae5917f4E",
        "11155111": "0xdd6D76262Fd7BdDe428dcfCd94386EbAe0151603",
      },
    },

    // SelfKisser -- fixed addresses per network, testnets + Gnosis only
    selfKisser: {
      label: "SelfKisser",
      addresses: {
        "11155111": "0x9eE458DefDc50409DbF153515DA54Ff5B744e533",
        "84532": "0x7D62Def8478c21B82aA7fcbc2E7f8B404Ac6c565",
        "421614": "0x4BAe02bED4b49DE3344878b0B0B2d6A58D47ddC5",
        "100": "0xE24c5cd952193eDA44BE71c19b35a9CB83cd1E24",
      },
      abi: SELF_KISSER_ABI,
    },
  },

  actions: [
    // Pre-populated feed actions -- one-click, no address needed
    ...feedActions("eth-usd", "ETH/USD", "ethUsd"),
    ...feedActions("btc-usd", "BTC/USD", "btcUsd"),
    ...feedActions("dai-usd", "DAI/USD", "daiUsd"),
    ...feedActions("usdc-usd", "USDC/USD", "usdcUsd"),
    ...feedActions("usdt-usd", "USDT/USD", "usdtUsd"),
    ...feedActions("link-usd", "LINK/USD", "linkUsd"),

    // Custom oracle actions -- user provides any Chronicle oracle address
    {
      slug: "read",
      label: "Read Oracle Value (Custom)",
      description:
        "Read the current price value from any Chronicle oracle. Caller must be whitelisted (kissed).",
      type: "read",
      contract: "customOracle",
      function: "read",
      inputs: [],
      outputs: [
        {
          name: "value",
          type: "uint256",
          label: "Oracle Value",
          decimals: 18,
        },
      ],
    },
    {
      slug: "try-read",
      label: "Try Read Oracle Value (Custom)",
      description:
        "Attempt to read the current price value from any Chronicle oracle. Returns ok=false instead of reverting if not whitelisted.",
      type: "read",
      contract: "customOracle",
      function: "tryRead",
      inputs: [],
      outputs: [
        {
          name: "ok",
          type: "bool",
          label: "Success",
        },
        {
          name: "value",
          type: "uint256",
          label: "Oracle Value",
          decimals: 18,
        },
      ],
    },
    {
      slug: "read-with-age",
      label: "Read Oracle Value with Age (Custom)",
      description:
        "Read the current price value and its last-updated timestamp from any Chronicle oracle.",
      type: "read",
      contract: "customOracle",
      function: "readWithAge",
      inputs: [],
      outputs: [
        {
          name: "value",
          type: "uint256",
          label: "Oracle Value",
          decimals: 18,
        },
        {
          name: "age",
          type: "uint256",
          label: "Last Updated (Unix timestamp)",
        },
      ],
    },
    {
      slug: "try-read-with-age",
      label: "Try Read Oracle Value with Age (Custom)",
      description:
        "Attempt to read the current price value and last-updated timestamp from any Chronicle oracle. Returns ok=false instead of reverting.",
      type: "read",
      contract: "customOracle",
      function: "tryReadWithAge",
      inputs: [],
      outputs: [
        {
          name: "ok",
          type: "bool",
          label: "Success",
        },
        {
          name: "value",
          type: "uint256",
          label: "Oracle Value",
          decimals: 18,
        },
        {
          name: "age",
          type: "uint256",
          label: "Last Updated (Unix timestamp)",
        },
      ],
    },

    // SelfKisser write action -- whitelist caller on a Chronicle oracle
    {
      slug: "self-kiss",
      label: "Whitelist on Oracle (Self)",
      description:
        "Whitelist the caller (msg.sender) on a Chronicle oracle using the SelfKisser contract. Only available on supported testnets.",
      type: "write",
      contract: "selfKisser",
      function: "selfKiss",
      inputs: [
        {
          name: "oracle",
          type: "address",
          label: "Oracle Contract Address",
        },
      ],
    },
  ],
});
