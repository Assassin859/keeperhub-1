---
title: "Blockscout Plugin"
description: "Query the Blockscout block explorer REST API for address, transaction, and token data."
---

# Blockscout Plugin

Read on-chain data from any Blockscout-powered block explorer. All actions are read-only and work against the public Ethereum mainnet instance out of the box. Connect an instance to query a different chain or raise rate limits with an API key.

## Actions

| Action | Description |
|--------|-------------|
| Get Address Balance | Look up the native coin balance and metadata for an address |
| Get Transaction | Fetch details for a transaction by hash |
| Get Token Info | Fetch metadata for an ERC-20/721/1155 token contract |

## Setup

No setup is required to query Ethereum mainnet. To use a different Blockscout instance or an API key:

1. In KeeperHub, go to **Connections > Add Connection > Blockscout**
2. Set the **Blockscout Instance URL** (for example `https://base.blockscout.com`)
3. Optionally add an **API Key** for higher rate limits
4. Save the connection and select it on the action

## Get Address Balance

Look up the native coin balance and metadata for an account or contract address.

**Inputs:** Address (supports `{{NodeName.field}}` variables)

**Outputs:** `address`, `balance` (wei), `isContract`, `ensName`, `success`, `error`

**When to use:** Monitor a treasury or wallet balance, branch on whether an address is a contract, resolve an ENS name before notifying.

**Example workflow:**
```
Schedule (every 10 min)
  -> Get Address Balance (treasury address)
  -> Condition: balance < threshold
  -> Discord: "Treasury low: {{GetAddressBalance.balance}} wei"
```

## Get Transaction

Fetch status and details for a transaction by hash.

**Inputs:** Transaction Hash (supports `{{NodeName.field}}` variables)

**Outputs:** `hash`, `status`, `value`, `from`, `to`, `blockNumber`, `fee`, `method`, `success`, `error`

**When to use:** Confirm a transaction succeeded before continuing, read the value or method of an observed transaction, surface fees in a report.

**Example workflow:**
```
Webhook (tx hash received)
  -> Get Transaction: {{Webhook.hash}}
  -> Condition: status == "ok"
  -> Telegram: "Tx confirmed in block {{GetTransaction.blockNumber}}"
```

## Get Token Info

Fetch metadata for a token contract.

**Inputs:** Token Address (supports `{{NodeName.field}}` variables)

**Outputs:** `address`, `name`, `symbol`, `decimals`, `totalSupply`, `type`, `holders`, `success`, `error`

**When to use:** Resolve a token symbol and decimals before formatting amounts, track total supply changes, label a token in notifications.

**Example workflow:**
```
Manual trigger
  -> Get Token Info: token address
  -> SendGrid: "{{GetTokenInfo.symbol}} supply is {{GetTokenInfo.totalSupply}}"
```
