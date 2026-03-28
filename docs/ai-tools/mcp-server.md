---
title: "MCP Server"
description: "Model Context Protocol server for AI agents to build and manage KeeperHub workflows programmatically."
---

# MCP Server

The KeeperHub MCP server exposes tools over the Model Context Protocol, enabling AI agents to create, execute, and monitor blockchain automation workflows.

## Connect to KeeperHub MCP

### Remote (recommended)

Connect directly to KeeperHub's hosted MCP server. No local process or CLI installation needed.

```bash
claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp
```

Then run `/mcp` inside Claude Code to complete the OAuth authorization via browser. KeeperHub will ask you to approve access, and the token is stored automatically.

For headless or CI environments where browser auth is not available, pass an API key:

```bash
claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

### Via Claude Code Plugin

Install the [Claude Code Plugin](/ai-tools/claude-code-plugin) for additional skills and slash commands on top of the MCP tools. The plugin connects to the same remote endpoint.

### Local via kh CLI (deprecated)

The [`kh` CLI](https://github.com/KeeperHub/cli) can run a local MCP server over stdio via `kh serve --mcp`. This is deprecated in favor of the remote endpoint above and will be removed in a future release.

## Authentication

The MCP endpoint supports two authentication methods:

**OAuth 2.1 (browser-based):** When you add the remote MCP server, Claude Code discovers the OAuth metadata at `/.well-known/oauth-authorization-server` and opens a browser for authorization. Tokens are managed automatically (1-hour access tokens, 30-day refresh tokens).

**API keys (headless):** Pass an organization API key (`kh_` prefix) as a Bearer token. Create one at [app.keeperhub.com](https://app.keeperhub.com) under Settings > API Keys > Organisation tab.

## Organization Scoping

Each MCP connection is scoped to a single organization. The org is determined by your authentication method:

- **OAuth:** The org active in your browser session when you approve the authorization request.
- **API key:** The org the key was created in (visible on the API Keys page).

All tools operate within this org -- listing workflows, creating workflows, executing, and viewing integrations. There is no way to access another org's resources from the same connection.

### Switching Organizations

To work with a different org, re-authenticate:

**OAuth (Claude Code):** Switch your active org at [app.keeperhub.com](https://app.keeperhub.com) using the org switcher, then reconnect the MCP server. In Claude Code, remove and re-add the server:

```bash
claude mcp remove keeperhub
claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp
```

Complete the OAuth flow again -- the new active org will be captured.

**API key:** Create a separate API key in the target org and update the MCP server configuration with the new key.

### Working with Multiple Organizations

If you regularly work across multiple orgs, add a separate MCP server entry for each:

```json
{
  "mcpServers": {
    "keeperhub-acme": {
      "type": "http",
      "url": "https://app.keeperhub.com/mcp",
      "headers": { "Authorization": "Bearer kh_acme_key" }
    },
    "keeperhub-personal": {
      "type": "http",
      "url": "https://app.keeperhub.com/mcp",
      "headers": { "Authorization": "Bearer kh_personal_key" }
    }
  }
}
```

Each server entry has its own tool namespace, so the AI agent can distinguish which org to target based on the server name.

## Tools Reference

### Workflow Management

| Tool | Description |
|------|-------------|
| `list_workflows` | List all workflows in the organization. Accepts `limit` and `offset` for pagination. |
| `get_workflow` | Get full workflow configuration by ID including nodes and edges. |
| `create_workflow` | Create a workflow with explicit nodes and edges. Call `list_action_schemas` first to get valid action types. |
| `update_workflow` | Update a workflow's name, description, nodes, or edges. |
| `delete_workflow` | Permanently delete a workflow and stop all its executions. Use `force: true` to delete workflows with execution history (cascades to all runs and logs). |

### Execution

| Tool | Description |
|------|-------------|
| `execute_workflow` | Manually trigger a workflow. Returns an execution ID for status polling. |
| `get_execution_status` | Check whether an execution is pending, running, completed, or failed. |
| `get_execution_logs` | Get detailed logs including transaction hashes, API responses, and errors. |

### AI Generation

| Tool | Description |
|------|-------------|
| `ai_generate_workflow` | Generate a workflow from a natural language prompt. Optionally modifies an existing workflow. |

### Action Schemas

| Tool | Description |
|------|-------------|
| `list_action_schemas` | List available action types and their configuration fields. Filter by category: `web3`, `discord`, `sendgrid`, `webhook`, `system`. |

### Plugins

| Tool | Description |
|------|-------------|
| `search_plugins` | Search plugins by name or category (`web3`, `messaging`, `integration`, `notification`). |
| `get_plugin` | Get full plugin documentation with optional examples and config field details. |
| `validate_plugin_config` | Validate an action configuration against its schema. Returns errors and suggestions. |

### Templates

| Tool | Description |
|------|-------------|
| `search_templates` | Search pre-built workflow templates by query, category, or difficulty. |
| `get_template` | Get template metadata and setup guide. |
| `deploy_template` | Deploy a template to your account with optional node customizations. |

### Integrations

| Tool | Description |
|------|-------------|
| `list_integrations` | List configured integrations. Filter by type (`web3`, `discord`, `sendgrid`, etc.). |
| `get_wallet_integration` | Get the wallet integration ID needed for write operations (transfers, contract calls). |

### Documentation

| Tool | Description |
|------|-------------|
| `tools_documentation` | Get documentation for any MCP tool. Use without arguments for a full tool list. |

## Resources

The server exposes two MCP resources:

| URI | Description |
|-----|-------------|
| `keeperhub://workflows` | List of all workflows |
| `keeperhub://workflows/{id}` | Full workflow configuration |

## Creating a Workflow

A typical workflow creation flow:

1. **Discover actions** -- call `list_action_schemas` with a category to see available action types and their required fields
2. **Build nodes** -- construct trigger and action nodes with the correct `actionType` values
3. **Connect nodes** -- define edges from trigger to actions in execution order
4. **Create** -- call `create_workflow` with nodes and edges (auto-layouts positions)
5. **Test** -- call `execute_workflow` and poll `get_execution_status`

### Node Structure

```json
{
  "id": "check-balance",
  "type": "action",
  "data": {
    "label": "Check Balance",
    "description": "Check wallet ETH balance",
    "type": "action",
    "config": {
      "actionType": "web3/check-balance",
      "network": "11155111",
      "address": "0x..."
    },
    "status": "idle"
  }
}
```

Trigger nodes use `type: "trigger"` with a `triggerType` in the config (`Manual`, `Schedule`, `Webhook`, `Event`).

### Edge Structure

Edges connect nodes and define execution flow:

```json
{
  "id": "edge-1",
  "source": "trigger-1",
  "target": "check-balance"
}
```

For **Condition nodes** and **For Each nodes**, edges require a `sourceHandle` field:

```json
{
  "id": "edge-2",
  "source": "condition-1",
  "target": "send-alert",
  "sourceHandle": "true"
}
```

| Source Node Type | sourceHandle Values |
|------------------|---------------------|
| Condition | `"true"` or `"false"` |
| For Each | `"loop"` or `"done"` |
| Other nodes | Omit field |

### Condition Nodes

Condition nodes have dual output paths with `true` and `false` source handles. Connect downstream nodes to the appropriate handle to create if/else logic in a single Condition node.

Conditions support these operators: `==` (soft equals), `===` (equals), `!=` (soft not equals), `!==` (not equals), `>`, `>=`, `<`, `<=`, `contains`, `startsWith`, `endsWith`, `matchesRegex`, `isEmpty`, `isNotEmpty`, `exists`, `doesNotExist`.

Conditions reference previous node outputs using template syntax: `{{@nodeId:Label.field}}`.

## Web3 Action Reference

### Read Actions (no wallet required)

| Action | Required Fields |
|--------|----------------|
| `web3/check-balance` | `network`, `address` |
| `web3/check-token-balance` | `network`, `address`, `tokenAddress` |
| `web3/read-contract` | `network`, `contractAddress`, `functionName` |

### Write Actions (require wallet integration)

| Action | Required Fields |
|--------|----------------|
| `web3/transfer-funds` | `network`, `toAddress`, `amount`, `walletId` |
| `web3/transfer-token` | `network`, `toAddress`, `tokenAddress`, `amount`, `walletId` |
| `web3/write-contract` | `network`, `contractAddress`, `functionName`, `walletId` |

Get the `walletId` by calling `get_wallet_integration`.

The `network` field accepts chain IDs as strings: `"1"` (Ethereum mainnet), `"11155111"` (Sepolia), `"8453"` (Base), `"42161"` (Arbitrum), `"137"` (Polygon).

## Error Handling

All tools return errors in this format:

```json
{
  "content": [{ "type": "text", "text": "Error: <message>" }],
  "isError": true
}
```

| Code | Meaning |
|------|---------|
| 401 | Invalid or missing API key |
| 404 | Workflow or execution not found |
| 400 | Invalid parameters |
| 500 | Server error |
