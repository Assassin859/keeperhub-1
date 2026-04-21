---
title: "x402 Wallets for AI Agents"
description: "Install an x402 wallet in your AI agent so it can pay for KeeperHub workflows (or any x402 service)."
---

# x402 Wallets for AI Agents

KeeperHub paid workflows settle via the [x402 payment protocol](https://docs.cdp.coinbase.com/x402): each call carries a USDC payment, and the server returns the result only after the payment is verified. To call a paid workflow, your agent needs an x402 wallet.

This page lists current x402 wallet options. KeeperHub does not run any of them -- both are third-party tools in the wider x402 ecosystem. Each works with KeeperHub and with every other x402-compliant service.

## agentcash

`agentcash` is a CLI + skill bundle from [agentcash.dev](https://agentcash.dev). It maintains a local USDC wallet and signs x402 payments on the agent's behalf.

```bash
npx agentcash add https://app.keeperhub.com
```

This walks KeeperHub's `/openapi.json`, generates a `keeperhub` skill file, and symlinks it into every detected agent skill directory. After install, agents can call `search_workflows` and `call_workflow` as first-class tools; payment is routed through the agentcash wallet automatically.

Supported agents (17 at time of writing): Claude Code, Cursor, Cline, Windsurf, Continue, Roo Code, Kilo Code, Goose, Trae, Junie, Crush, Kiro CLI, Qwen Code, OpenHands, Gemini CLI, Codex, GitHub Copilot.

> **Testing only. Do not custody real funds.**
> agentcash stores the wallet key as an **unencrypted plaintext file** at `~/.agentcash/wallet.json`. There is no passphrase, no keychain integration, and no seed-phrase backup -- if the file is deleted, lost, or read by any process running as your user, the funds are gone or stolen. This is appropriate for development and automation experiments with small balances (e.g. a few dollars of USDC to pay for test calls), but it is **not** a production wallet.
>
> KeeperHub does not operate agentcash and is not responsible for funds stored in an agentcash wallet. Use it at your own risk and do not top it up beyond what you are willing to lose.

## Coinbase agentic wallet skills

Coinbase publishes a bundle of 9 general-purpose x402 skills that work with any x402-compliant service, including KeeperHub:

```bash
npx skills add coinbase/agentic-wallet-skills
```

This installs skills including `authenticate-wallet`, `fund`, `pay-for-service`, `search-for-service`, `send-usdc`, `trade`, `query-onchain-data`, and `x402`. The wallet is managed through Coinbase Developer Platform; payment flows route through the CDP infrastructure.

Full documentation and security risk ratings: https://skills.sh/coinbase/agentic-wallet-skills

## Which wallet should I use?

Both wallets can call any x402-compliant service, KeeperHub included, so the choice depends on your agent's existing setup and custody preferences, not on anything KeeperHub-specific.

- **Pick agentcash** for a quick-start install of KeeperHub (or any x402 origin) as a first-class skill. Keep in mind agentcash keys are plaintext on disk -- it is a testing wallet, not a production one.
- **Pick Coinbase agentic wallet skills** if you already run a CDP wallet, want managed key infrastructure, or prefer the broader Coinbase x402 ecosystem.

Nothing stops you from installing both -- they do not conflict.

## What KeeperHub exposes to the agent

Regardless of which wallet you install, the agent calls KeeperHub through two meta-tools (described in its OpenAPI at `/openapi.json`):

- `search_workflows` -- find workflows by category, tag, or free text. Returns slug, description, inputSchema, and price for each match.
- `call_workflow` -- execute a listed workflow by slug. For read workflows the call executes and returns the result; for write workflows it returns unsigned calldata `{to, data, value}` for the caller to submit.

This meta-tool pattern keeps the agent's tool list small no matter how many workflows are listed -- the agent discovers available workflows at runtime instead of registering one tool per workflow.

## Paying for calls

Paid workflows settle in USDC on Base (via x402) or USDC.e on Tempo (via MPP). Most workflows cost under `$0.05` per call. See [Paid Workflows](/workflows/paid-workflows) for the creator-side view of the same settlement.
