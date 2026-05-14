import { defineAbiProtocol } from "@/lib/protocol-registry";
import depositPoolAbi from "./abis/rocket-pool-deposit-pool.json";
import rethAbi from "./abis/rocket-pool-reth.json";

const ROCKET_POOL_DOCS = "https://docs.rocketpool.net/guides/staking/via-rp";

export default defineAbiProtocol({
  name: "Rocket Pool",
  slug: "rocket-pool",
  description:
    "Decentralized Ethereum liquid staking: deposit ETH for rETH, monitor exchange rates, and manage staking positions",
  website: "https://rocketpool.net",
  icon: "/protocols/rocket-pool.png",

  contracts: {
    reth: {
      label: "rETH Token",
      abi: JSON.stringify(rethAbi),
      addresses: {
        "1": "0xae78736Cd615f374D3085123A210448E74Fc6393",
      },
      overrides: {
        getExchangeRate: {
          label: "Get rETH Exchange Rate",
          description:
            "Get the current ETH value of 1 rETH (exchange rate from rETH to ETH)",
          outputs: {
            rate: {
              label: "Exchange Rate (wei per rETH)",
              decimals: 18,
            },
          },
        },
        balanceOf: {
          label: "Get rETH Balance",
          description: "Check the rETH balance of an address",
          inputs: {
            account: {
              label: "Wallet Address",
              helpTip:
                "Address whose rETH balance will be read from the contract.",
              docUrl: ROCKET_POOL_DOCS,
            },
          },
          outputs: {
            balance: {
              label: "rETH Balance (wei)",
              decimals: 18,
            },
          },
        },
        totalSupply: {
          label: "Get rETH Total Supply",
          description: "Get the total supply of rETH tokens in circulation",
          outputs: {
            totalSupply: {
              label: "Total rETH Supply (wei)",
              decimals: 18,
            },
          },
        },
        getTotalCollateral: {
          label: "Get Total ETH Collateral",
          description:
            "Get the total amount of ETH collateral held by the rETH contract",
          outputs: {
            totalCollateral: {
              label: "Total ETH Collateral (wei)",
              decimals: 18,
            },
          },
        },
        burn: {
          label: "Burn rETH for ETH",
          description:
            "Burn rETH tokens to receive the underlying ETH back at the current exchange rate",
          inputs: {
            _rethAmount: {
              name: "amount",
              label: "rETH Amount (wei)",
              helpTip:
                "Amount of rETH to burn, in wei. The contract returns ETH at the current exchange rate (see Get rETH Exchange Rate).",
              docUrl: ROCKET_POOL_DOCS,
              decimals: 18,
            },
          },
        },
      },
      events: {
        TokensMinted: {
          label: "rETH Minted",
          description: "Fires when rETH tokens are minted after an ETH deposit",
        },
        TokensBurned: {
          label: "rETH Burned",
          description:
            "Fires when rETH tokens are burned to redeem the underlying ETH",
        },
      },
    },
    depositPool: {
      label: "Rocket Deposit Pool",
      abi: JSON.stringify(depositPoolAbi),
      addresses: {
        "1": "0xDD3f50F8A6CafbE9b31a427582963f465E745AF8",
      },
      overrides: {
        deposit: {
          label: "Deposit ETH for rETH",
          description:
            "Deposit ETH into Rocket Pool to receive rETH liquid staking tokens",
        },
      },
      events: {
        DepositReceived: {
          label: "Deposit Received",
          description:
            "Fires when ETH is deposited into the Rocket Pool deposit pool",
        },
      },
    },
  },
});
