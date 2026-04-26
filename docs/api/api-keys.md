---
title: "API Keys"
description: "KeeperHub API Keys - create and manage API keys for programmatic access."
---

# API Keys

Manage API keys for programmatic access to the KeeperHub API.

## Key Types

KeeperHub has two distinct key systems, managed at different endpoints. They are not interchangeable.

| Prefix | Scope | Managed at | Used for |
|--------|-------|------------|----------|
| `kh_` | Organization | `/api/keys` | REST API, MCP server, Claude Code plugin |
| `wfb_` | User | `/api/api-keys` | Webhook triggers |

For typical programmatic API access use organization (`kh_`) keys.

## Organization Keys (`kh_`)

Issued per-organization. Create them from Settings > API Keys > Organisation in the dashboard, or via the endpoints below.

### List Organization Keys

```http
GET /api/keys
```

Accepts session or API-key authentication. Returns non-revoked keys for the active organization.

#### Response

```json
[
  {
    "id": "key_123",
    "name": "Production Key",
    "keyPrefix": "kh_abc",
    "createdAt": "2024-01-01T00:00:00Z",
    "lastUsedAt": "2024-01-15T12:00:00Z",
    "createdByName": "Jane Doe",
    "expiresAt": null
  }
]
```

The full key is never returned after creation.

### Create Organization Key

```http
POST /api/keys
```

**Session authentication required.** Cannot be invoked with an API key -- otherwise a leaked key could mint additional keys for the same organization.

#### Request Body

```json
{
  "name": "My API Key",
  "expiresAt": "2025-01-01T00:00:00Z"
}
```

`expiresAt` is optional. Omit for a non-expiring key.

#### Response

```json
{
  "id": "key_123",
  "name": "My API Key",
  "key": "kh_full_api_key_here",
  "keyPrefix": "kh_full_",
  "createdAt": "2024-01-01T00:00:00Z",
  "expiresAt": null
}
```

Copy the `key` value immediately. It is only shown once.

### Revoke Organization Key

```http
DELETE /api/keys/{keyId}
```

Soft-revokes the key. Subsequent requests with that key return `401`.

#### Response

```json
{
  "success": true
}
```

## User Keys (`wfb_`)

Issued per-user. Intended for webhook triggers, not for general REST API access.

### List User Keys

```http
GET /api/api-keys
```

Session authentication required.

### Create User Key

```http
POST /api/api-keys
```

Session authentication required.

#### Request Body

```json
{
  "name": "My Webhook Key"
}
```

### Delete User Key

```http
DELETE /api/api-keys/{keyId}
```

Session authentication required. Revokes the key. This action cannot be undone.

## Security Notes

- Keys are hashed with SHA256 before storage; only the prefix is kept for identification.
- Anonymous users cannot create API keys.
- Revoke compromised keys immediately.
- Store keys in environment variables, not in source code.
- Key creation and personal-key deletion require session authentication, so a leaked API key cannot mint or delete other keys.
