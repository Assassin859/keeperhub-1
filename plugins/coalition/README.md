# Coalition

Multi-party on-chain commitments inside a KeeperHub workflow.

## What it does

A coalition is N parties (2-20) who post an ERC-20 stake, agree to a hash of off-chain terms, and each sign on-chain by a deadline. Once activated, any party can be marked as having breached the agreement. Slashing transfers the breached party's stake pro-rata to non-breached participants. A clean close returns all non-breached stakes; an unsigned coalition past its deadline can refund whoever did sign.

## When to use it

- Cross-DEX MEV bundles (N searchers commit to a bundle, slash on free-rider)
- Multi-sig action coordination
- Group treasury actions
- Multi-party liquidations
- Group token buys
- Sharded compute coalitions
- Any workflow needing "N parties commit, any one can break, slashing on breach"

## Why this needs KeeperHub

Slashing transactions must land. The Slash Breached Party action exposes KeeperHub's reliability stack as primary configuration: private-mempool routing (Flashbots Protect on Base), explicit priority-fee override, RPC failover, and nonce session management. A naive RPC call cannot offer the same landing guarantees under gas spikes -- and a slash that doesn't land breaks the coalition's economic security.

## Actions

| Slug | Type | What it does |
|---|---|---|
| `propose` | write | Create a coalition; returns `coalitionId` |
| `sign` | write | Sign in (auto-approves stakeToken if needed); idempotent |
| `check-status` | read | Returns state, signed/breached/slashed counts, ready flag -- use for polling |
| `activate` | write | PROPOSED to ACTIVE once all signed; idempotent |
| `breach` | write | Record breach evidence against a participant |
| `slash` | write | Slash a breached party's stake (load-bearing, reliability-tuned) |
| `dissolve` | write | Clean close, return non-breached stakes (participant-only) |
| `expire` | write | Refund signers after deadline if not all signed (anyone-callable) |

## Example workflow

Three nodes wired together: propose, then poll until ready, then activate.

```json
{
  "nodes": [
    {
      "id": "Propose",
      "type": "coalition.propose",
      "config": {
        "network": "base-sepolia",
        "participants": "[\"0x...\", \"0x...\", \"0x...\"]",
        "termsHash": "0x...",
        "deadlineUnix": "{{Now.plusHours(24)}}",
        "stakeToken": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "stakePerParty": "1000000"
      }
    },
    {
      "id": "PollStatus",
      "type": "coalition.check-status",
      "config": {
        "network": "base-sepolia",
        "coalitionId": "{{Propose.coalitionId}}"
      },
      "loop": { "until": "{{PollStatus.ready == true}}", "intervalSec": 30 }
    },
    {
      "id": "Activate",
      "type": "coalition.activate",
      "config": {
        "network": "base-sepolia",
        "coalitionId": "{{Propose.coalitionId}}"
      }
    }
  ]
}
```

Because each KeeperHub workflow runs as a single Para wallet, multi-party signing is naturally a multi-workflow pattern: each participant runs their own KeeperHub workflow with a single `sign` step. The orchestration above belongs to one party (the proposer); the other participants run their own minimal workflows that call `sign` against the returned `coalitionId`.

## Deployments

| Chain | Chain ID | Address |
|---|---|---|
| Base Sepolia | 84532 | (paste after deploy) |
| Base Mainnet | 8453 | not yet deployed |

The contract is deployed out-of-band via `pnpm tsx scripts/deploy-coalition.ts --network base-sepolia` and verified on the block explorer. Update `plugins/coalition/contracts/addresses.ts` with the deployed address.

## Limitations (v1)

- Slash and recordBreach are anyone-callable. Production deployments should wrap with arbitrator-gating off-chain.
- ERC-20 stake only; no ETH or fee-on-transfer/rebasing tokens.
- Max 20 participants per coalition.
- Single-chain (no cross-chain coalitions in v1).
- The sponsored-execution path returns an empty `coalitionId` from `propose` because Pimlico bundlers don't surface event logs the same way. If your chain has gas sponsorship enabled and you need the ID immediately, run `check-status` against `nextId - 1` after the propose tx confirms, or deploy without sponsorship.
- Once a slash has occurred, the slashed party's stake is permanently removed; `dissolve` correctly skips them.
