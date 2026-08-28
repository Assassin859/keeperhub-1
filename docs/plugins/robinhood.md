---
title: "Robinhood Plugin"
description: "Read prices, positions, and trading status for the tokenised equities on Robinhood Chain."
---

# Robinhood Plugin

Read the tokenised equities on Robinhood Chain from a workflow. The three actions are read-only and need no credentials.

These actions exist because the assets are equities rather than ordinary tokens, and the generic Web3 actions cannot express that:

- A balance rescales without a transfer. After a corporate action such as a split, the same holding reports a different `balanceOf` while nothing moved.
- A price has two conventions that are not interchangeable: the issuer's quote for the underlying equity, and the on-chain Chainlink token price.
- The market behind the asset closes, while the chain does not.

Every action takes a **ticker**, not an address. The issuer's asset registry is the only authority on which contract is which equity; a symbol search on the chain explorer returns many lookalikes, several with more holders than the real token. All actions are pinned to Robinhood Chain (chain ID 4663), which is the only network the registry lists deployments on.

## Actions

| Action | Description |
|--------|-------------|
| Get Stock Token Price | Issuer bid and ask, plus the Chainlink token price where a feed exists |
| Get Stock Token Position | A holder's position in share terms and in raw on-chain units |
| Stock Market Status | Whether acting on this token's price is currently sane, and why not |

## Get Stock Token Price

Quotes a stock token by ticker. Returns both price conventions rather than reconciling them into one number: the issuer's `bid` and `ask` for the underlying equity, and `feedPrice` from Chainlink where a feed exists. Each carries its own age, and `uiMultiplier` is the scaling factor between the two conventions.

Only a minority of listed tickers have a Chainlink feed, so `feedPrice` and `feedAgeSeconds` are `null` for most tokens. The issuer quote covers every listed ticker, which is why it leads.

**Inputs:** Network (pinned to Robinhood Chain), Ticker (required, e.g. `AAPL`)

**Outputs:** `success`, `symbol`, `name`, `tokenAddress`, `currency`, `bid`, `ask`, `quoteGeneratedAt`, `quoteAgeSeconds`, `feedPrice`, `feedUpdatedAt`, `feedAgeSeconds`, `feedBeyondHeartbeat`, `uiMultiplier`, `isTradingHalt`, `paused`, `tokenPaused`, `oraclePaused`, `error`

**When to use:** Price alerts, portfolio valuation, spread monitoring.

**Note:** `bid` and `ask` are the issuer's prices for the underlying equity and are not multiplier adjusted. `feedPrice` is a token price and already has the multiplier applied. Compare like with like.

## Get Stock Token Position

Reads a holder's position in share terms and in raw on-chain units side by side.

Reading `balanceOf` alone understates a position by the multiplier on any token that has been through a corporate action, and does so silently. `shares` is what the holder is shown and what the position is worth, so act on that. `rawBalance` is what `transfer` moves and what a block explorer displays.

**Inputs:** Network (pinned to Robinhood Chain), Ticker (required), Holder Address (required)

**Outputs:** `success`, `symbol`, `tokenAddress`, `address`, `shares`, `rawBalance`, `uiMultiplier`, `valueAtBid`, `currency`, `quoteAgeSeconds`, `error`

**When to use:** Position monitoring, holding-value alerts, treasury reporting.

## Stock Market Status

A guard for price-reactive workflows. `tradeable` is a single boolean to branch on, and `blockedBy` lists every reason it is false, so a workflow can branch on the cause rather than re-deriving it. The causes are: a trading halt, each of the three independent on-chain pause flags, a stale issuer quote, a Chainlink feed beyond its heartbeat, and a pending corporate action.

Feed staleness is judged per feed against its own published heartbeat rather than a fixed threshold. These feeds run on a 24 hour heartbeat and legitimately sit hours old outside market hours, so a constant short enough to mean anything during a session would fire continuously overnight.

There is no market-status endpoint upstream, so "is the market open" is derived from the age of the issuer quote rather than fetched. This avoids shipping an exchange calendar and getting half-days wrong.

`pendingMultiplier` and `pendingEffectiveAt` give advance warning before a split or other corporate action lands.

**Inputs:** Network (pinned to Robinhood Chain), Ticker (required)

**Outputs:** `success`, `tradeable`, `blockedBy`, `isTradingHalt`, `paused`, `tokenPaused`, `oraclePaused`, `quoteAgeSeconds`, `feedAgeSeconds`, `feedBeyondHeartbeat`, `pendingMultiplier`, `pendingEffectiveAt`, `error`

**When to use:** Gate any workflow that acts on a stock token price, so it does not trade on a stale quote or through a halt.

## Example workflow

```
Schedule (every 15 minutes)
  -> Stock Market Status (AAPL)
  -> Condition: tradeable is true
  -> Get Stock Token Price (AAPL)
  -> Condition: bid is below threshold
  -> Slack: post the quote and its age
```
