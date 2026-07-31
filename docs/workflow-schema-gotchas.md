# KeeperHub Workflow Schema — The Undocumented Parts

This document captures everything we learned about KeeperHub's workflow
JSON schema that isn't in the official docs. It cost us ~6 hours of
trial and error. Hopefully it saves you that time.

---

## The critical fields

### `abi` — must be a JSON string, not an array

**Wrong (causes 422 error):**
```json
{
  "abi": [{ "name": "transfer", "type": "function", ... }]
}
```

**Correct:**
```json
{
  "abi": "[{\"name\":\"transfer\",\"type\":\"function\",...}]"
}
```

Always `JSON.stringify()` your ABI before putting it in the config.

---

### `functionArgs` — must be a JSON string of an array of objects with named fields

**Wrong:**
```json
{
  "functionArgs": ["0xRecipient", "1000000"]
}
```

**Also wrong:**
```json
{
  "functionArgs": [["0xRecipient", "1000000"]]
}
```

**Correct:**
```json
{
  "functionArgs": "[{\"to\":\"0xRecipient\",\"amount\":\"1000000\"}]"
}
```

Use named fields matching the ABI parameter names. Always `JSON.stringify()` the array.

---

### `tokenConfig` for `web3/approve-token` — must be a JSON string

**Wrong:**
```json
{
  "tokenConfig": "0xTokenAddress"
}
```

**Correct:**
```json
{
  "tokenConfig": "{\"mode\":\"custom\",\"customToken\":{\"address\":\"0xTokenAddress\",\"symbol\":\"USDC\"}}"
}
```

Always `JSON.stringify()` the tokenConfig object.

---

### Deadlines — never use template expressions in functionArgs

**Wrong (breaks JSON parsing at execution time):**
```json
{
  "functionArgs": "[{\"deadline\": {{@__system:System.unixTimestamp}} + 3600}]"
}
```

**Correct:**
```typescript
const deadline = Math.floor(Date.now() / 1000) + 600;
// Then use the number directly:
functionArgs: JSON.stringify([{ deadline: deadline }])
```

Template expressions (`{{@__system:...}}`) are resolved BEFORE JSON parsing,
producing invalid JSON like `1234567890 + 3600` which breaks the parser.

---

### `network` — chain ID as a string

```json
{
  "network": "11155111"  // Sepolia
  "network": "1"         // Ethereum mainnet
}
```

Not a number. Not a network name. A string chain ID.

---

## Endpoint quirks

### Create workflow
```
POST /api/workflows/create
```
Note: `/workflows/create` not `/workflows` — the extra `/create` is required.

### Execute workflow
```
POST /api/workflow/{workflowId}/execute
```
Note: `/workflow/` (singular) not `/workflows/` (plural) — yes, they're different.

### Get execution status
```
GET /api/workflows/executions/{executionId}/status
```
Back to plural `/workflows/` here.

### Get execution logs
```
GET /api/workflows/executions/{executionId}/logs
```

---

## Node structure

Every node (trigger and action) must follow this exact shape:

```typescript
{
  id: "unique-id",
  type: "trigger" | "action",
  data: {
    label: "Human readable name",
    type: "trigger" | "action",    // repeated from outer type
    config: { ... },               // action-specific config
    status: "idle",                // always "idle" when creating
    description: "",               // optional, can be empty string
  }
}
```

---

## Trigger node

```typescript
{
  id: "trigger",
  type: "trigger",
  data: {
    label: "Manual Trigger",
    type: "trigger",
    config: { triggerType: "manual" },
    status: "idle",
  }
}
```

Always required as the first node. `triggerType` must be lowercase `"manual"`.

---

## Edge structure

```typescript
{
  id: "e1",
  source: "trigger",
  target: "step-1"
}
```

Edges must connect nodes in order. The `id` is arbitrary but must be unique.

---

## Finding your wallet integration ID

```typescript
const res = await axios.get("https://app.keeperhub.com/api/integrations", {
  headers: { Authorization: `Bearer ${API_KEY}` }
});
const walletId = res.data.data[0].id;
```

Or run: `npm run example:read` — it prints all integrations.

---

## Gas limit multiplier

Add `gasLimitMultiplier: "1.5"` to write-contract configs to avoid out-of-gas errors on complex transactions.

---

## Transaction hash location in logs

KeeperHub doesn't return the tx hash in the execution status. You need to fetch logs:

```typescript
const logs = await getExecutionLogs(executionId);
for (const log of logs) {
  if (log.output?.transactionHash) return log.output.transactionHash;
  if (log.output?.transactionLink) {
    return log.output.transactionLink.match(/0x[a-fA-F0-9]{64}/)?.[0];
  }
}
```

---

## What we wish existed in the docs

1. A complete node config reference per action type
2. The `functionArgs` named-fields requirement explicitly documented
3. The `abi` stringification requirement explicitly documented
4. The `/workflow/` vs `/workflows/` endpoint inconsistency explained
5. A note that template expressions break JSON parsing in functionArgs
6. The `tokenConfig` structure for `web3/approve-token`

These are all reasonable improvements to the official docs.
If you run into more undocumented behavior, open an issue on the
KeeperHub GitHub repo — they're responsive and this is all open source.