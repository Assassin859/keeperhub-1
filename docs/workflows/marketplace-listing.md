---
title: "Listing to the Marketplace"
description: "Publish workflows to the KeeperHub Marketplace for other users and AI agents to discover and call."
---

# Listing Workflows to the Marketplace

The KeeperHub Marketplace lets you publish workflows for other users and AI agents to discover and call. You set the slug, the price, and the input/output interface. KeeperHub handles routing, payment settlement, and execution. You collect 70% of every call.

This page covers everything from preparing a workflow to receiving your first payment.

---

## How it works

When you list a workflow, KeeperHub registers it as a resource under KeeperHub's entry on the x402 and MPP registries (ERC-8004). Agents browsing those registries discover KeeperHub as a service provider and see all listed workflows as callable resources.

From the caller's perspective, a listed workflow is a black box: they supply the inputs you define, pay the price you set, and receive the outputs you expose. The internal node structure stays private.

Payments settle in USDC on Base (via x402) or USDC.e on Tempo (via MPP). Agents don't need ETH for gas. KeeperHub facilitators handle fee submission.

---

## Before you list

Your workflow must be production-ready before listing. A few things to confirm:

**The workflow runs reliably.** Test it manually using the "Run workflow" button in the editor. Confirm the execution completes and the output contains the fields you want to expose.

**Dynamic inputs use references, not hardcoded values.** If your workflow needs caller-supplied data (a wallet address, a token symbol, an amount), that value cannot be hardcoded into a node field. It has to come from the manual trigger via a field reference. The reason: hardcoded values are fixed at build time. A field reference pulls the value the caller supplies at runtime.

To set this up, add a Manual trigger node. In the downstream node where the dynamic value is needed, click the field, choose "Add" from the type selector, and select the corresponding field from the trigger's output. The field now reads from caller-supplied input instead of a static value.

**The workflow is set to active.** Listed workflows must be enabled. An inactive workflow will reject calls.

---

## Listing a workflow

Open the workflow in the KeeperHub editor. Click the **Marketplace** button in the top toolbar.

### Slug

The slug is the permanent identifier for this workflow on the registry. Once you publish, it cannot be changed.

Choose something clear and specific. Use lowercase letters, numbers, and hyphens only.

Good examples:
- `aave-v3-health-check`
- `eth-balance`
- `stablecoin-yield-rates`

Avoid generic slugs like `my-workflow` or `test`. The slug appears in URLs, registry listings, and agent discovery results.

### Price

The amount (in USDC) charged per call. You can change this after publishing.

Most utility workflows on the marketplace price between $0.01 and $0.05 per call. Price relative to the value the workflow provides and the cost of the computation it performs. Agents make many calls; a workflow priced too high gets abandoned for alternatives.

### Input schema

Input schema defines what the caller must supply. Each field you add here becomes a required parameter in the API call.

For each field, provide:
- **Field name**: the key name the caller uses (e.g., `address`, `asset`, `chain`)
- **Type**: `string`, `number`, or `boolean`
- **Description**: one sentence explaining what the field expects

Every field in the input schema must be referenced somewhere in a workflow node, otherwise the value is received but never used. The most common pattern is: Manual trigger collects all input fields, downstream nodes reference those fields via the field picker.

Example input schema for a wallet health check workflow:
```json
{
  "address": {
    "type": "string",
    "description": "EVM wallet address to check"
  },
  "chain": {
    "type": "string",
    "description": "Chain name: ethereum or base"
  }
}
```

### Output schema

Output schema defines what the workflow returns to the caller after execution. You select which node outputs to expose.

In most cases, you expose all fields from the final data node in your workflow. Click "All fields from [node name]" to expose everything that node produces, or select individual fields if you want to filter the response.

Keep outputs clean. Return the data the caller asked for. Avoid exposing internal fields, intermediate values, or debug information that isn't useful to a consumer.

---

## After listing

Once listed, your workflow turns green in the editor and appears on your Earnings page.

Your workflow is now registered on both x402scan.com and mppscan.com under KeeperHub's registration. Agents browsing those registries will see it as a callable resource.

The slug, your listed price, and your input/output schema are what agents see. The internal node logic stays private.

---

## Earnings

Every call to your listed workflow generates revenue. KeeperHub takes a 30% platform fee. You receive 70%.

You can see your earnings breakdown on the **Earnings** page in KeeperHub:
- Total invocations
- Gross revenue (total USDC paid by callers)
- Platform fee (30%)
- Your earnings (70%)

Earnings are broken down by payment network (Base via x402, Tempo via MPP).

---

## How agents call your workflow

Agents discover and call your workflow via two meta-tools exposed through KeeperHub's OpenAPI:

- `search_workflows`: find workflows by name, tag, or description. Returns slug, input schema, and price.
- `call_workflow`: execute a workflow by slug, supplying the required inputs.

Agents need an agentic wallet to pay for calls. Three wallet options are available:

### KeeperHub Agentic Wallet (recommended)

Install with two commands:
```
npx -p @keeperhub/wallet keeperhub-wallet skill install
npx -p @keeperhub/wallet keeperhub-wallet add
```

Custody is server-side via Turnkey's secure enclave. No private key lands on disk. Supports both x402 (Base USDC) and MPP (Tempo USDC.e). Includes a three-tier safety hook (auto-approve, ask, block) with a configurable spending threshold.

After install, restart the agent session once so it picks up the new skill.

### agentcash (for development and testing)

```
npx agentcash add https://app.keeperhub.com
```

Walks KeeperHub's OpenAPI, generates a skill file, and installs it across detected agent runtimes. Supports x402. Private key is stored unencrypted on disk, so treat it as a low-balance testing wallet only.

### Coinbase Agentic Wallet Skills

```
npx skills add coinbase/agentic-wallet-skills
```

Requires a Coinbase Developer Platform account. Supports x402. Includes general-purpose onchain utility skills in addition to payment support.

---

## Payment networks

**Base via x402.** The agent signs an EIP-3009 `TransferWithAuthorization`. A facilitator submits the transaction and pays the gas. The agent only debits the USDC amount. No ETH required.

**Tempo via MPP.** The agent signs a payment proof. The MPP facilitator pays network fees. The agent only debits the USDC.e amount. When both networks are available, agents using the KeeperHub wallet auto-select MPP for faster, cheaper settlement.

---

## Changing your listing

After publishing, you can update:
- Listed price
- Output schema

You cannot change:
- Slug (permanent once set)
- Input schema fields already in use by callers (adding new optional fields is fine; removing or renaming existing ones breaks callers)

To make a significant change to the workflow logic, update the nodes and test before the change goes live. Callers hitting your slug during a failed execution see an error and are not charged.

---

## Things to know

**Workflow logic is private.** Callers see your input schema, output schema, and price. They cannot inspect your nodes or execution logic.

**The slug appears on registry explorers.** x402scan.com and mppscan.com list your workflow under KeeperHub's registration. Choose a slug you're comfortable having public.

**You are responsible for workflow reliability.** Callers are charged only on successful execution, but repeated failures reduce trust. Monitor your invocations on the Earnings page and test after any workflow changes.

**Workflows run under your KeeperHub organization.** Your organization's connected wallets, integrations, and execution credits are used when the workflow runs for a caller.
