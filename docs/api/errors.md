---
title: "Error Codes"
description: "KeeperHub API error codes and troubleshooting guide."
---

# Error Codes

Reference for API error codes and how to resolve them.

## Error Response Format

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable description"
  }
}
```

## HTTP Status Codes

| Status | Description |
|--------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing or invalid authentication |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource does not exist |
| 409 | Conflict - Idempotency-Key reused or request already in progress |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

## Common Error Codes

### Authentication Errors

| Code | Description | Resolution |
|------|-------------|------------|
| `UNAUTHORIZED` | Missing authentication | Include valid session or API key |
| `INVALID_API_KEY` | API key is invalid or revoked | Generate a new API key |
| `SESSION_EXPIRED` | Session has expired | Re-authenticate |

### Validation Errors

| Code | Description | Resolution |
|------|-------------|------------|
| `INVALID_INPUT` | Request body validation failed | Check required fields |
| `INVALID_ADDRESS` | Invalid Ethereum address | Verify address format |
| `INVALID_CHAIN_ID` | Unsupported chain ID | Use supported chain |

### Idempotency Errors

| Code | Description | Resolution |
|------|-------------|------------|
| `idempotency_conflict` | The `Idempotency-Key` was reused with a different request body. Response includes `originalExecutionId`. | Use a new key for a different request |
| `idempotency_in_progress` | A request with this `Idempotency-Key` is still being processed | Retry shortly |

See [Direct Execution](/api/direct-execution#idempotency) for the full idempotency policy.

### Resource Errors

| Code | Description | Resolution |
|------|-------------|------------|
| `NOT_FOUND` | Resource does not exist | Verify resource ID |
| `ALREADY_EXISTS` | Resource already exists | Use update instead |
| `PERMISSION_DENIED` | No access to resource | Verify ownership |

### Execution Errors

| Code | Description | Resolution |
|------|-------------|------------|
| `EXECUTION_FAILED` | Workflow execution failed | Check execution logs |
| `INSUFFICIENT_FUNDS` | Wallet lacks funds for gas | Top up Para wallet |
| `GAS_LIMIT_EXCEEDED` | Transaction exceeded gas limit | Increase gas limit |
| `CONTRACT_ERROR` | Smart contract reverted | Check contract state |

### Rate Limiting

| Code | Description | Resolution |
|------|-------------|------------|
| `RATE_LIMITED` | Too many requests | Wait and retry |

#### Rate-limit headers

Every response from a rate-limited endpoint (both success and `429`) carries the current limiter state, so clients can pace requests instead of guessing:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests left in the current window |
| `X-RateLimit-Reset` | Unix epoch (seconds) when the window frees a slot |
| `Retry-After` | Seconds to wait before retrying (sent only on `429`) |

Status and long-poll endpoints additionally return `X-Poll-Interval-Hint`: the server-recommended number of seconds to wait before polling again. A value of `0` means the resource has reached a terminal state and no further polling is needed.

> Anti-abuse endpoints (for example password reset and MFA enrollment) intentionally omit `X-RateLimit-Remaining` so they don't disclose a caller's remaining attempt budget. They still send `Retry-After` on `429`.

## Retry Strategy

For transient errors (5xx, rate limits), use exponential backoff:

```
Wait time = min(base * 2^attempt, max_wait)
```

Recommended:
- Base: 1 second
- Max attempts: 5
- Max wait: 30 seconds
