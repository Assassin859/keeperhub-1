---
title: Agent Quick Start (Programmatic)
description: Trigger a KeeperHub workflow and get a transaction hash back, entirely from code — no dashboard clicking required.
---

# Agent Quick Start

The [Quick Start Guide](/getting-started/quickstart) walks through building a workflow by hand in the visual canvas. This page is for the other half of KeeperHub's users: an agent, or a backend service acting on one, that needs to **trigger an existing workflow from code** and **read the result back programmatically**.

If you haven't built a workflow yet, do that first — this page covers *execution*, not *authoring*. The fastest way to author one is still the canvas in the [Quick Start Guide](/getting-started/quickstart), or describe it to the **Ask AI...** assistant on the canvas.

## Which execution path do you want?

KeeperHub has two ways to get a transaction onchain. Pick based on what you're building:

| | Direct Execution | Workflow Execution |
|---|---|---|
| **Use when** | One-off contract call or transfer, no branching logic | Multi-step logic, conditions, or a workflow you'll reuse across triggers |
| **Setup** | No workflow object needed | Requires a workflow created in advance (dashboard or API) |
| **CLI** | `kh execute contract-call`, `kh execute transfer` | N/A — API only |
| **API** | `POST /api/execute/contract-call` | `POST /api/workflows/{id}/execute` |

This page covers **Workflow Execution** — the more common pattern for an agent that already has a workflow and needs to trigger it as one step in a larger decision loop.

## 1. Get an API key

`app.keeperhub.com` → Settings → API Keys. A wallet is auto-provisioned for your organization on signup — no separate wallet setup needed.

## 2. Fund the wallet if your workflow spends gas

Profile icon → **Wallet**. Top up with ETH on whichever network your workflow targets.

> **Gas sponsorship covers Mainnet Ethereum only.** If you're testing on Sepolia or any other testnet, the wallet needs its own funded balance regardless of sponsorship — this trips people up specifically because it's easy to test on a testnet first and assume sponsorship applies there too.

## 3. Trigger the workflow

```bash
curl -X POST https://app.keeperhub.com/api/workflows/{workflowId}/execute \
  -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```js
const res = await fetch(`https://app.keeperhub.com/api/workflows/${workflowId}/execute`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.KEEPERHUB_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({}),
});
const { executionId } = await res.json();
```

This only returns `{ executionId, status: "running" }` — no transaction hash yet. That comes from the next step.

## 4. Wait for it to finish

```js
async function waitForExecution(executionId) {
  const res = await fetch(
    `https://app.keeperhub.com/api/workflows/executions/${executionId}/wait?timeoutMs=55000`,
    { headers: { Authorization: `Bearer ${process.env.KEEPERHUB_API_KEY}` } }
  );
  const data = await res.json();
  if (data.status === "error") throw new Error(data.error);
  if (!data.completed) throw new Error("Didn't finish within the wait window");
  return data;
}
```

`/wait` blocks server-side until the execution reaches a terminal state, so you don't need to write your own poll loop. If you'd rather poll yourself (e.g. to show incremental progress), `GET /api/workflows/executions/{id}/status` is the non-blocking equivalent — same response shape, returns immediately with the current status.

## 5. Read the result

A successful execution includes the transaction hash of any onchain write the workflow performed:

```js
const result = await waitForExecution(executionId);
console.log(result.transactionHashes[0].hash);
```

That's the full loop. See the [full API reference](/api) for execution history, error shapes, and the executions list endpoint.

## Common issues

- **A key that "looks" set but isn't.** If you're validating config before running (recommended), check for placeholder patterns explicitly — an all-zeros private key (`0x000...0`) or a literal `your_key_here` string will pass a naive `if (key)` truthiness check and fail later with a confusing signing error instead of a clear "not configured" message.
- **404 on execute.** Usually means the workflow ID is wrong or belongs to a different organization than the API key.
- **Execution stuck in `pending`.** Check the wallet's balance on the target network first — see the gas sponsorship note above.

## Runnable example

A minimal, complete version of this flow (trigger → poll → confirm, with proper env validation) is available as a standalone template: [keeperhub-agent-quickstart](https://github.com/chriswilton971-sudo/keeperhub-agent-quickstart).
