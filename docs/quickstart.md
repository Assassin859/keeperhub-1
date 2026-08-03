---
title: "Hackathon Quickstart"
description: "Everything you need to integrate KeeperHub in one place - MCP endpoint, supported chains, USDC addresses, faucets, API key types, and rate limits."
---

# Hackathon Quickstart

A single copy-paste reference for the facts you need in the first thirty minutes:
where the MCP endpoint is, which chains are supported, which USDC address and
faucet to use, what the two API key types are for, and the rate limits. Each
section links to its full reference page.

## 1. Connect the MCP endpoint

The hosted MCP server is the fastest way to drive KeeperHub from an AI agent.

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

Run `/mcp` in Claude Code to complete OAuth in the browser. For headless or CI
environments, pass an organization API key instead:

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

Every listed marketplace workflow is also reachable as its own typed MCP server
at `https://app.keeperhub.com/mcp/w/<slug>`. See the [MCP Server](/ai-tools/mcp-server)
reference for the full tool list and per-workflow details.

The endpoint URL is also shown, with a copy button, in the dashboard under
**Settings -> API Keys**.

### OAuth vs API keys

Browser OAuth (for example `/mcp` in Claude Code) mints a **Bearer OAuth access
token**, not a `kh_` organization API key. The MCP server accepts either an
OAuth access token or `Authorization: Bearer kh_...` on each request. Do not pass
a `kh_` key to the OAuth token endpoint — it is rejected by design.

| Auth method | Credential | Best for |
|-------------|------------|----------|
| OAuth (browser) | Short-lived Bearer access token | Interactive agents, Claude Code `/mcp` |
| Organization API key (`kh_`) | Long-lived org key from Settings -> API Keys | Headless CI, scripts, Docker |

For programmatic REST and MCP access without a browser redirect, create an
organization key at **Settings -> API Keys**. See [MCP Server auth](/ai-tools/mcp-server)
and [API Keys](/api/api-keys).

### Local and Docker MCP

Self-hosted KeeperHub exposes MCP at `http://localhost:3000/mcp`. OAuth
redirect flows require a reachable callback URL; when that is impractical (for
example inside Docker without a browser), prefer a `kh_` key:

```bash
claude mcp add --transport http --scope user keeperhub http://localhost:3000/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

For local development with a browser, `pnpm dev:login` opens a signed-in
Chromium session. Set `DEV_LOGIN_URL` if the app is not on `http://localhost:3000`.

### Simulation is EVM-only

`simulate: true` on MCP direct-execution tools (`execute_transfer`, etc.) works
on **EVM chain IDs only**. Solana mainnet (`101`) and devnet (`103`) return a
structured error with code `simulation_unsupported_chain` before any API call.
See [section 6](#6-send-your-first-transaction-safely) for the full preflight flow.

## 2. Pick a key type

KeeperHub has two key systems. They are not interchangeable.

| Prefix | Scope | Managed at | Use for |
|--------|-------|------------|---------|
| `kh_` | Organization | `/api/keys` | REST API, MCP server, Claude Code plugin |
| `wfb_` | User | `/api/api-keys` | Webhook trigger authentication |

For programmatic API and MCP access, use an organization (`kh_`) key. OAuth
browser sign-in is a third MCP-only path (see [OAuth vs API keys](#oauth-vs-api-keys))
and is not a substitute for `kh_` on REST endpoints. Full details:
[API Keys](/api/api-keys).

## 3. Supported chains

Status reflects support maturity: **stable** chains are production-ready;
**experimental** chains are accepted but may behave unreliably (for example,
broadcasts can hang) and should not be used for production writes without
opting in explicitly.

Start on a testnet. Fund the wallet with native gas first, then test USDC.

### Testnets (recommended for hacking)

| Network | chainId | USDC | Faucets | Status |
|---|---|---|---|---|
| Ethereum Sepolia | `11155111` | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | [ETH](https://cloud.google.com/application/web3/faucet/ethereum/sepolia), [USDC](https://faucet.circle.com) | stable |
| Base Sepolia | `84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | [ETH](https://portal.cdp.coinbase.com/products/faucet), [USDC](https://faucet.circle.com) | stable |

### Mainnets

| Network | chainId | USDC | Status |
|---|---|---|---|
| Ethereum | `1` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | stable |
| Base | `8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | stable |
| Arbitrum One | `42161` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | stable |
| Optimism | `10` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | stable |
| Polygon | `137` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | stable |

### Experimental

| Network | chainId | Status |
|---|---|---|
| 0G | `16661` | experimental |
| 0G Galileo (testnet) | `16602` | experimental |

The live source of truth for chains is `GET /api/chains`; agents can read the
same list (including per-chain `status`) from the `list_action_schemas` MCP
tool. Faucet links are third-party and may change. See the full
[Chains](/api/chains) reference for chain-name aliases and ABI fetching.

## 4. Rate limits

| Context | Limit |
|---|---|
| Authenticated requests | 100 / minute |
| Unauthenticated requests | 10 / minute |
| Direct execution (per API key) | 60 / minute |

Rate-limited requests return `429` with a `Retry-After` header (seconds or an
HTTP-date). When you hit a limit:

1. Read `Retry-After` and wait at least that many seconds before retrying.
2. Use exponential backoff with a cap (for example 1s, 2s, 4s, up to 60s).
3. On write operations, pass a stable `idempotency_key` so retries are safe.

Workflow creation and AI generation can also return `upstream_cold_start` during
serverless cold starts — retry with the same `idempotency_key` after the
suggested delay. See [MCP Server cold starts](/ai-tools/mcp-server) and
[Direct Execution](/api/direct-execution) for spending caps.

## 5. Sandbox

The Code action runs untrusted JavaScript in an isolated `node:vm` sandbox with
outbound SSRF protection. See [Code Plugin](/plugins/code) for what is allowed
and blocked.

## 6. Send your first transaction safely

The MCP direct execution tools let an agent preflight and broadcast without
switching to a separate API client. Start with a testnet wallet funded from the
faucets above, then use this sequence:

1. Call `execute_transfer` with `simulate: true`.
2. Continue only when the result has `success: true` and
   `wouldRevert: false`.
3. Repeat the same call with `simulate` omitted and a new
   `idempotency_key`.
4. Pass the returned `executionId` to `get_direct_execution_status` and poll
   until the status is `completed` or `failed`.
5. Save `transactionLink` from the terminal response as the onchain proof.

Example simulation on Base Sepolia:

```json
{
  "chain_id": "84532",
  "to_address": "0xRecipient",
  "amount": "0.01",
  "simulate": true
}
```

For an ERC-20 transfer, also pass the token's contract address as
`token_address`. The Base Sepolia USDC address is listed in the table above.
Any MCP tool error is a failed preflight and must stop the flow; revert details
include the REST error JSON when available. As noted in [section 1](#simulation-is-evm-only),
simulation is EVM-only — `execute_transfer` rejects `simulate: true` for Solana
chain IDs `101` and `103` and their aliases with `simulation_unsupported_chain`
before making an API call.
See [MCP Server](/ai-tools/mcp-server#safely-preflight-direct-writes) for the
tool flow and [Direct Execution](/api/direct-execution) for complete response
and error handling details.
