---
title: "Executions API"
description: "KeeperHub Executions API - monitor workflow execution status and retrieve logs."
---

# Executions API

Monitor and manage workflow executions.

## List Executions

```http
GET /api/workflows/{workflowId}/executions
```

Returns execution history for a workflow.

### Response

```json
[
  {
    "id": "exec_123",
    "workflowId": "wf_456",
    "status": "success",
    "input": {...},
    "output": {...},
    "startedAt": "2024-01-01T00:00:00Z",
    "completedAt": "2024-01-01T00:00:05Z",
    "transactionHashes": [
      {
        "hash": "0x111...",
        "nodeId": "approve-token-1",
        "nodeName": "Approve USDC",
        "chainId": 1,
        "network": "mainnet"
      }
    ]
  }
]
```

## Get Execution Status

```http
GET /api/workflows/executions/{executionId}/status
```

Returns real-time execution status with progress tracking.

### Response

```json
{
  "status": "success",
  "nodeStatuses": [
    { "nodeId": "node_1", "status": "success" },
    { "nodeId": "node_2", "status": "success" }
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
      "nodeId": "approve-token-1",
      "nodeName": "Approve USDC",
      "chainId": 1,
      "network": "mainnet"
    },
    {
      "hash": "0x222...",
      "nodeId": "write-contract-1",
      "nodeName": "Swap on Uniswap",
      "chainId": 1,
      "network": "mainnet"
    }
  ]
}
```

### Status Values

| Status | Description |
|--------|-------------|
| `pending` | Execution queued |
| `running` | Currently executing |
| `success` | Completed successfully |
| `error` | Failed with error |
| `cancelled` | Manually cancelled |

### Transaction Hashes

`transactionHashes` is the full ordered list of on-chain writes recorded by the workflow, in submission order. Single-tx workflows have a one-element array; multi-tx workflows (approve+swap, fan-out transfers, For-Each loops) have N elements. Each entry has:

| Field | Type | Description |
|-------|------|-------------|
| `hash` | string | 0x-prefixed transaction hash |
| `nodeId` | string | Workflow node identifier that produced the hash |
| `nodeName` | string | Human-readable label from the canvas |
| `chainId` | number (optional) | EIP-155 chain id, when emitted by the step |
| `network` | string (optional) | Network slug (e.g. `mainnet`, `arbitrum`) |
| `iterationIndex` | number (optional) | 0-based For-Each loop index; present only for entries produced inside a For-Each iteration |

Workflows that produce no on-chain writes return an empty array. For full per-step input, output, error, and timing detail, use the logs endpoint below.

## Get Execution Logs

```http
GET /api/workflows/executions/{executionId}/logs
```

Returns detailed logs for each node in the execution along with the execution row itself.

### Response

```json
{
  "execution": {
    "id": "exec_123",
    "workflowId": "wf_456",
    "status": "success",
    "startedAt": "2024-01-01T00:00:00Z",
    "completedAt": "2024-01-01T00:00:05Z"
  },
  "logs": [
    {
      "id": "log_789",
      "executionId": "exec_123",
      "nodeId": "node_1",
      "nodeName": "Check Balance",
      "nodeType": "trigger",
      "status": "success",
      "input": {...},
      "output": {...},
      "duration": 1234,
      "startedAt": "2024-01-01T00:00:00Z",
      "completedAt": "2024-01-01T00:00:01Z"
    }
  ]
}
```

**Event Trigger Outputs**: When a workflow is triggered by a blockchain event, the trigger node's `output` object automatically includes block explorer links:
- `transactionLink` - Direct link to the transaction in the block explorer (when the event contains a transaction hash)
- `addressLink` - Direct link to the address in the block explorer (when the event contains an address)

These links are generated using the network's configured block explorer and are available in addition to the standard event data fields.

## Delete Executions

```http
DELETE /api/workflows/{workflowId}/executions
```

Bulk delete execution history for a workflow.
