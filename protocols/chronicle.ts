import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: "Chronicle",
  slug: "chronicle",
  description:
    "Chronicle Protocol -- decentralized, verifiable oracle price feeds with Schnorr signature verification",
  website: "https://chroniclelabs.org",
  icon: "/protocols/chronicle.png",

  contracts: {
    oracle: {
      label: "Chronicle Oracle",
      userSpecifiedAddress: true,
      // Reference addresses (ETH/USD oracle) for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field.
      // Each oracle pair has a different contract address.
      addresses: {
        // Ethereum Mainnet (ETH/USD reference)
        "1": "0x46ef0071b1E2fF6B42d36e5A177EA43Ae5917f4E",
        // Ethereum Sepolia (ETH/USD reference)
        "11155111": "0xdd6D76262Fd7BdDe428dcfCd94386EbAe0151603",
      },
      // Inline ABI -- Chronicle oracles may not be verified on all block explorers
      abi: JSON.stringify([
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
      ]),
    },
    selfKisser: {
      label: "SelfKisser",
      // Fixed addresses per network -- no mainnet (requires Discord support ticket)
      addresses: {
        // Ethereum Sepolia
        "11155111": "0x9eE458DefDc50409DbF153515DA54Ff5B744e533",
        // Base Sepolia (84532)
        "84532": "0x7D62Def8478c21B82aA7fcbc2E7f8B404Ac6c565",
        // Arbitrum Sepolia (421614)
        "421614": "0x4BAe02bED4b49DE3344878b0B0B2d6A58D47ddC5",
        // Gnosis Mainnet (100)
        "100": "0xE24c5cd952193eDA44BE71c19b35a9CB83cd1E24",
      },
      // Inline ABI -- SelfKisser contract
      abi: JSON.stringify([
        {
          type: "function",
          name: "selfKiss",
          stateMutability: "nonpayable",
          inputs: [{ name: "oracle", type: "address" }],
          outputs: [],
        },
      ]),
    },
  },

  actions: [
    // Read actions on oracle contract (userSpecifiedAddress)

    {
      slug: "read",
      label: "Read Oracle Value",
      description:
        "Read the current price value from a Chronicle oracle. Caller must be whitelisted (kissed) to read.",
      type: "read",
      contract: "oracle",
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
      label: "Try Read Oracle Value",
      description:
        "Attempt to read the current price value from a Chronicle oracle. Returns ok=false instead of reverting if not whitelisted.",
      type: "read",
      contract: "oracle",
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
      label: "Read Oracle Value with Age",
      description:
        "Read the current price value and its last-updated timestamp from a Chronicle oracle.",
      type: "read",
      contract: "oracle",
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
      label: "Try Read Oracle Value with Age",
      description:
        "Attempt to read the current price value and last-updated timestamp. Returns ok=false instead of reverting if not whitelisted.",
      type: "read",
      contract: "oracle",
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

    // Write action on SelfKisser contract (fixed addresses, testnets only)

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
