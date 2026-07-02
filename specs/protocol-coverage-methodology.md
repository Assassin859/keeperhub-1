# Protocol Coverage Suite: Methodology and Limits

Status: living document. Covers `tests/e2e/vitest/protocol-coverage/`
(KEEP-458 originally, hardened under KEEP-590).

## What the suite is

A per-action execution suite for protocol registry actions. For each
`(protocol, chain)` with a `coverage.test.ts`, the runner iterates every
registered action of a phase (`read`, then `write`), builds a two-node
webhook-triggered workflow for it (`buildActionWorkflow`), inserts it for
the persistent test user, fires it over the real webhook endpoint, and
polls `workflow_executions` for a terminal status.

Enumeration is registry-driven: a newly added action is covered by
default. Excluding one requires a `skipped` entry with a written reason,
which the vitest reporter surfaces on every run.

## Assertion layers

1. Liveness (always): the execution reaches `status === "success"`.
   Because the executor flips the workflow to `error` when any step throws
   or returns `{success:false}`, and writes run a staticCall preflight,
   broadcast for real, and wait for the receipt (with an explicit
   `receipt.status === 0` guard in `confirmTransaction`), a green write
   proves a real signed transaction mined without reverting.
2. Output oracle (per-action, declared in testData `expectations`): after
   success, the runner loads the action node's recorded output from
   `workflow_execution_logs` (`output_raw`) and checks declarative
   assertions against `result`. See `OutputExpectation` in
   `lib/test-data/types.ts` and `_shared/oracle.ts`. Without an
   expectation entry, a read passes on any non-throwing call regardless of
   the value returned - expectations exist to close exactly that gap.

Expectation semantics: `field` is a dot-path into the structured result
(`structureAbiOutputs` keys multi-output and named-single-output reads by
ABI output name; unnamed single outputs are the bare value). Predicates:
`nonZero`, `notEmpty`, `equals`; every expectation implies existence.

Rules for writing expectations:

- Assert only values the suite provisions itself (positions opened by the
  setup workflow) or long-lived chain invariants (an exchange rate, a
  Safe's threshold).
- All suites share one Turnkey test wallet and vitest runs suite files
  concurrently. Do not assert values another suite can move (shared token
  balances). This is also why there is no balance-delta oracle for writes:
  deltas on a shared wallet are nondeterministic by design here, and the
  receipt-level guarantees already prove the write executed on-chain.
- On a long-lived local fork, state accumulates across runs. Do not
  assert values that depend on run history (see rocket-pool `balance-of`).

## Environments

- Ethereum mainnet suites run against a local anvil fork (chain 1 is in
  `FORK_CHAIN_IDS`); funding is `anvil_setBalance` plus whale
  impersonation (`FORK_WHALES`). No live mainnet is ever touched.
- Sepolia suites (superfluid, chronicle) run against the live testnet and
  need `TESTNET_FUNDER_PK`.
- Base (ajna) is live Base mainnet, reads only; every write is skipped and
  the gas preflight short-circuits, so no real ETH is spent.
- Payable actions bind the virtual `ethValue` key (plain ETH string), and
  userSpecifiedAddress contracts bind the virtual `contractAddress` key.

## Gating and the vacuous-pass hazard

Every suite self-skips when `DATABASE_URL`, `ANVIL_FORK_MAINNET_URL`
(mainnet suites), or `TESTNET_FUNDER_PK` (live-chain suites) is absent, or
when `SKIP_INFRA_TESTS=true`. A green `pnpm test:protocol` therefore does
not by itself mean anything executed; CI must run with the secrets
provisioned and should alarm on the executed-test count, not just the exit
code.

## Known limits (intentional, revisit when scope changes)

- Triggers are not tested. The runner fires workflows via webhook, which
  ignores trigger config; Schedule/Event trigger behavior needs its own
  harness. Seeded trigger-variant workflows are dashboard fixtures, not
  test signal.
- One chain per protocol. Multi-chain protocols are exercised on a single
  chain (mainnet fork where possible); L2 deployments are unvalidated
  until a second fork is added.
- Actions with unmet on-chain prerequisites (vault/pool addresses, open
  auctions, cooldowns) are skipped with reasons. Skip reasons must name
  the real constraint - "payable" was wrong for frax/rocket-pool (the
  harness supports `ethValue`) and those are now exercised.
- Reads without an expectations entry remain liveness-only.

## Adding a new protocol/chain suite

1. Ensure the protocol's `TEST_DATA` has the chain: `setup` (gas floor,
   required tokens, approvals, optional protocol steps), `actions` input
   bindings, `skipped` reasons, `expectations` for reads.
2. For mainnet-fork tokens, add `TOKEN_REGISTRY` and `FORK_WHALES` entries
   in `lib/test-data/chain-test-data.ts`; for testnets add `FAUCETS`.
3. Copy an existing `coverage.test.ts` (lido for fork-gated mainnet,
   superfluid for funder-gated live chains) and change the constants.
4. Verify third-party state assumptions empirically (eth_call) and record
   the date in a comment, as done in `protocols/safe.ts` and
   `protocols/aave-v3.ts`.

## Measured progress

Numbers come from `pnpm coverage:report` (the same planPhaseFixtures the
runner uses, so they cannot drift from what actually registers). One row
per landed phase of the local-first coverage plan; wall-clock times are
timed local runs unless marked CI.

| Date | Milestone | Runnable | Skipped | Value-asserted | Executing in CI | Feedback loop |
|---|---|---|---|---|---|---|
| 2026-07-02 | Baseline (post suite-hardening PR) | 232 of 394 (19 protocol-chains; 16 behind the hard-skipped chronicle suite, 7 in orphaned aave-v3 Sepolia testData) | 117 | 8 actions | ~35 (mainnet fork secret unprovisioned; chronicle hard-skipped) | 30-35 min per CI round |
| 2026-07-02 | Local rig codified (scripts/protocol-local.sh) | unchanged; all 232 runnable actions now executable locally (local mainnet fork needs no secret; writes need TURNKEY_* exported) | unchanged | unchanged | unchanged | local: cold up 7m49s (incl. build), warm up 59s, single suite validated end to end in 27s (safe 6/6 with oracle assertions); vs 30-35 min per CI round |
| 2026-07-02 | Tier 0 calldata tests (tests/unit/protocol-calldata.test.ts) | first 100% layer: all 394 registry actions encode-tested (synthetic), plus bound-encode goldens for every testData chain (18 golden files) | n/a (encoding layer has no skips; skipped-and-unencodable states recorded in goldens) | exact-calldata assertion for every bound action | adds 476 tests to the unit gate that already runs on every PR | 2.4s for the full layer; mutation check (scripts/protocol-mutation-check.sh) confirms a renamed ABI input goes red |
