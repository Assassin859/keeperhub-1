import { defineAbiProtocol } from "@/lib/protocol-registry";
import wethAbi from "./abis/weth.json";

export default defineAbiProtocol({
  name: "WETH",
  slug: "weth",
  description:
    "Wrapped Ether - wrap ETH to WETH (ERC-20) and unwrap back to ETH",
  website: "https://weth.io",
  icon: "/protocols/weth.png",

  contracts: {
    weth: {
      label: "WETH Contract",
      abi: JSON.stringify(wethAbi),
      addresses: {
        "1": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "8453": "0x4200000000000000000000000000000000000006",
        "42161": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        "10": "0x4200000000000000000000000000000000000006",
        "11155111": "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
      },
      overrides: {
        deposit: {
          slug: "wrap",
          label: "Wrap ETH",
          description:
            "Wrap native ETH into WETH (ERC-20). Send ETH value with the transaction.",
        },
        withdraw: {
          slug: "unwrap",
          label: "Unwrap WETH",
          description: "Unwrap WETH back to native ETH",
          inputs: {
            wad: { label: "Amount (wei)" },
          },
        },
        balanceOf: {
          slug: "balance-of",
          label: "Get Balance",
          description: "Check WETH balance of an address",
          inputs: {
            arg0: { name: "account", label: "Wallet Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "WETH Balance (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
