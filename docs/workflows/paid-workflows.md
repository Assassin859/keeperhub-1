---
title: "Paid Workflows"
description: "List workflows for AI agents to call on demand and earn revenue on Base or Tempo."
---

# Paid Workflows

When you list a workflow as paid, AI agents can discover and call it via KeeperHub's MCP endpoint. Each call settles on-chain in USDC, with the creator wallet as the recipient. Revenue arrives on either Base or Tempo depending on which protocol the calling agent uses.

## How payment works

Agents can pay using one of two protocols, and both are always offered on every paid workflow call:

| Protocol | Chain | Token | Used by |
|---|---|---|---|
| x402 | Base (chain ID 8453) | USDC (`0x8335...02913`) | Agentcash wallets with a Base balance, Coinbase CDP-backed agents |
| MPP | Tempo (chain ID 4217) | USDC.e (`0x20c0...8b50`) | Agentcash wallets with a Tempo balance, MPP-native clients |

The calling agent chooses which protocol to use based on what its wallet holds. A workflow creator does not pick one — both chains are live on every listed workflow, and you receive funds on whichever chain the caller paid from.

## Receiving revenue on two chains

After a caller pays, the USDC (or USDC.e) lands directly in your organization's creator wallet. Because the two chains settle in different tokens, you will see two balances in your wallet overlay:

- **Base USDC** — accumulates from x402 calls
- **Tempo USDC.e** — accumulates from MPP calls

Both are fully redeemable stablecoins pegged to USD. The split is purely a function of which agents called your workflow. There is nothing to configure, and no balance is "incorrect" if one chain has zero activity.

### Why Tempo?

Tempo has faster finality and predictable gas costs, which matters for high-throughput agent traffic. Base has the broader ecosystem and more wallet support today. KeeperHub supports both because different agents run on different wallets — forcing a single chain would exclude either the Coinbase Agent Kit ecosystem (Base) or the MPP-native wallet ecosystem (Tempo).

### Consolidating your balance

If you prefer a single-chain balance, you can bridge between Base and Tempo through the relevant chain bridges. KeeperHub does not auto-bridge — creator funds stay in the wallet you registered. See [Wallet Management](/wallet-management) for details on accessing the wallet.

## Listing a workflow

1. Open a workflow you want to list
2. Click the **List** button in the workflow toolbar
3. Set a per-call price in USDC and (optionally) a category and tags
4. Save — the workflow is now callable by agents via `https://app.keeperhub.com/api/mcp/workflows/<slug>/call`

Listed workflows are discoverable by x402scan, mppscan, and agentcash through their OpenAPI / `PAYMENT-REQUIRED` probes. No registration form is required for these scanners.

## Pricing guidance

Most listed workflows price between `$0.001` and `$0.10` per call. Agents pay per-request, so a price that sounds negligible in isolation adds up at scale. Consider:

- The workflow's runtime cost (gas, RPC, external API calls)
- How long the execution takes
- Whether the output is a one-shot answer or part of a chained agent session

You can update the price at any time on existing listed workflows. Prior calls settle at the price active when the call was made.

## Dogfood reference

The `mcp-test` workflow listed at `https://app.keeperhub.com/api/mcp/workflows/mcp-test/call` is the reference implementation. It is priced at `$0.01` per call, accepts both x402 and MPP payments, and its `/openapi.json` entry is what the scanners ingest.
