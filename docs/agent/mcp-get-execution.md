---
title: "Get Execution"
description: "The response shape of the get_execution MCP tool: the nested status/logs structure, which fields are numbers versus strings, and the order log entries arrive in."
---

# get_execution

`get_execution` returns combined status and step-by-step logs for a workflow execution in a single response: `{ status, logs }`. This page documents that response shape, which is not otherwise written down — the tool description covers arguments, not the two objects it hands back.

## Tool call

```json
{
  "tool": "get_execution",
  "arguments": {
    "executionId": "exec_abc123"
  }
}
```

### Arguments

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `executionId` | string | Yes | The execution ID returned by `execute_workflow`. |
| `includeData` | boolean | No (default `true`) | Include `input`/`output`/`outputRaw` blobs on each log entry. Pass `false` for a compact status-only response. |
| `nodeIds` | string[] | No | Restrict full input/output/outputRaw data to these node IDs (exact, case-sensitive). Other entries still return `status`, `error`, `nodeName`, `nodeType`, `startedAt`, `completedAt`, `duration`, `timestamp`, `iterationIndex`, `forEachNodeId`. Has no effect when `includeData` is `false`. |
| `truncateData` | number | No | Per-field byte cap. Any oversized `input`/`output`/`outputRaw` payload is replaced with `{ _truncated: true, originalSize, preview }`. `error` is never truncated. |

## Response shape

```json
{
  "status": {
    "status": "success",
    "nodeStatuses": [
      { "nodeId": "trigger", "status": "success" },
      { "nodeId": "transfer-1", "status": "success" }
    ],
    "progress": {
      "totalSteps": 2,
      "completedSteps": 2,
      "runningSteps": 0,
      "currentNodeId": null,
      "currentNodeName": null,
      "percentage": 100
    },
    "errorContext": null,
    "transactionHashes": [
      {
        "hash": "0x111...",
        "nodeId": "transfer-1",
        "nodeName": "Transfer",
        "chainId": 1,
        "network": "mainnet",
        "verified": true,
        "receiptStatus": "success"
      }
    ]
  },
  "logs": {
    "execution": {
      "id": "exec_abc123",
      "workflowId": "wf_456",
      "status": "success",
      "totalSteps": "2",
      "completedSteps": "2",
      "duration": "1834",
      "transactionHashes": [ "... same shape as status.transactionHashes ..." ],
      "...": "every other workflow_executions column"
    },
    "logs": [
      { "nodeId": "transfer-1", "nodeName": "Transfer", "status": "success", "startedAt": "...", "...": "..." },
      { "nodeId": "trigger", "nodeName": "Manual Trigger", "status": "success", "startedAt": "...", "...": "..." }
    ]
  }
}
```

`status` and `logs` are independent reads of the same execution (a status-table read and a logs-table read), not one derived from the other. Two things fall out of that worth knowing before you write a decoder:

### `totalSteps`, `completedSteps`, and `duration` are numbers in `status.progress`, strings in `logs.execution`

`status.progress.totalSteps` / `completedSteps` are parsed to real numbers before being returned. The same fields on `logs.execution` are not — they come straight off the `workflow_executions` row, where `total_steps` and `completed_steps` are `text` columns and `duration` is `numeric` (Postgres numeric columns serialize as strings to avoid precision loss). So `status.progress.completedSteps === 2` (number) and `logs.execution.completedSteps === "2"` (string) describe the same run. If you read progress, read it from `status.progress`, not `logs.execution`.

### `logs.logs` arrives newest-first, not in execution order

The per-node entries in `logs.logs` are ordered by `timestamp` descending — the most recently completed node first. That is reverse-chronological, not the order the workflow actually ran in. If you need execution order:

- Sort `logs.logs` by `startedAt` ascending yourself, or
- Read `logs.execution.executionTrace`, an array of node IDs in the order the executor actually ran them, populated on every execution regardless of outcome.

`status.errorContext.executionTrace` carries the same array, but only when the run ended in `error` or `system_error` — `logs.execution.executionTrace` is the one field present on every execution.

### `errorContext` is `null` on every non-error status

`status.errorContext` is populated only when `status.status` is `"error"` or `"system_error"`. It is `null` for `pending`, `running`, `unconfirmed`, `success`, `cancelled`, and `phantom` — not omitted, `null`.

### `transactionHashes` is an array of receipt objects, not hash strings

Both `status.transactionHashes` and `logs.execution.transactionHashes` are arrays of receipt objects (`hash`, `nodeId`, `nodeName`, `verified`, `receiptStatus`, ...), not plain strings. See [Transaction Hashes](/api/executions#transaction-hashes) for the full field table.

## Cross-organization executions

For an execution you can see only through its workflow's public share setting (not one your organization owns), the shape changes:

```json
{
  "status": { "...": "same shape, but node identifiers are redacted" },
  "logs": null,
  "note": "This execution belongs to another organization and is visible only through its workflow's public share setting. Step logs are withheld and the status is redacted (node identifiers omitted); includeData, nodeIds and truncateData do not apply."
}
```

`logs` is `null` rather than an empty object — a client that only checks `logs.logs` without checking `logs` itself first will throw here.

## Deprecated aliases

`get_execution_status` and `get_execution_logs` return the `status` and `logs` objects above individually (same field shapes, same caveats), not the combined response. Both are deprecated as of v1.13 in favor of `get_execution`.
