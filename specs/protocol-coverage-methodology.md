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

Fork RPC fetch cache: a pinned anvil fork persists every upstream fetch
(accounts, storage slots, block hashes - eth_call reads included) to its
on-disk cache, and a fresh fork started with that cache mounted at the
same pin serves all of it locally while staying pristine - the cache
holds upstream fetches, never local mutations, so the sweep re-runs
cleanly on top. The nightly `fork-cache-mainnet` job warms and publishes
this cache; the tier1 CI job consumes it, and
`scripts/protocol-local.sh` (`snapshot` subcommand,
`MAINNET_FORK_CACHE_DIR` / `SEPOLIA_FORK_CACHE_DIR`) produces and
consumes it locally. The upstream is still required at fork startup
(chain id, block env) and by the mining loop (block hashes), so the
cache removes hot-path state reads without replacing the archive
upstream - CI consumption is gated on `ANVIL_FORK_MAINNET_URL` for
exactly that reason. Naming is aligned on one token, `mainnet`: the
artifact (`fork-cache-mainnet`), the tar
(`fork-cache-mainnet-<block>.tgz`), the cache dir (`mainnet-<block>/`),
and the env var (`MAINNET_FORK_CACHE_DIR`). That coupling is
load-bearing - the tier1 download step locates the tar by the exact
`fork-cache-mainnet-*.tgz` pattern the nightly packaging step writes,
so the two must change together.

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

## Validating workflow changes locally (act + rig)

Division of labor when touching the CI workflows:

- The rig (`scripts/protocol-local.sh`) validates step logic: run the
  exact command sequence a step executes (e.g. the vitest+floor pair)
  against the local stack before pushing.
- `act` validates workflow structure and wiring: parse, job graph,
  reusable-workflow resolution, gate conditions, and that jobs launch
  with their service containers. Recipe:

  ```
  act pull_request -W .github/workflows/ci-pipeline.yml \
    -e <event.json with the run-e2e-tests-ephemeral label> \
    --var ENABLE_E2E_EPHEMERAL_TESTS=true \
    [-n for dry-run | -j <job> to execute one job]
  ```

  Known boundaries: dry-run cannot traverse jobs whose `if:` reads
  another job's outputs (dry steps produce none); executing jobs that
  use artifact actions needs a runner image with node
  (`-P ubuntu-latest=catthehacker/ubuntu:act-latest`); service ports
  bind on the host, so local containers holding 5432 collide with the
  postgres service.

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
| 2026-07-03 | Tier 1 fork simulations (tests/e2e/vitest/protocol-simulation, scripts/protocol-local.sh sim) | chain 1: 275 tests collected (13 protocols), 144 pass through real fork execution (impersonation replaces signing, direct RPC replaces the executor; setup provisioning, ordered writes, oracle-asserted reads), 86 documented skips, 45 fail | unchanged | oracle assertions run per read at this tier too | not wired to CI yet (env-gated) | 155s for the chain-1 sweep with zero app/signing infrastructure. The 45 failures are newly exposed latent defects, not harness bugs: yearn's fallback vault is a 45-byte proxy with no implementation (27 reads), chainlink CCIP and curve bindings target codeless or reverting addresses on chain 1, morpho's set-authorization fixture duplicates its setup step, and rocket-pool's deposit reverts "Invalid or outdated contract" (stale registry address - a user-facing bug). None of these could surface before: the mainnet e2e suites have never executed in CI. Catalogued for the skip-unlock/testData-repair phase. |
| 2026-07-03 | Latent defect repairs (Tier 1 catalogue) | chain-1 Tier 1 sweep fully green: 185 pass, 90 documented skips, 0 fail in ~3 min. +41 actions actually work now: yearn (27) and curve (5) bind live contracts (userSpecifiedAddress contracts ignore the registry fallback, so unbound actions had no target at all), chainlink's generic feed reads bind the canonical ETH/USD aggregator (5), morpho's set-authorization polarity and its ABI order (supplyCollateral before borrow) fixed (3), and rocket-pool's deposit-pool registry address updated to the current deployment resolved from RocketStorage (1) - that one was a live user-facing bug. 4 CCIP token checks became honest skips (testnet-only surface). Tier 0 now rejects runnable actions that resolve no target address, closing the defect class. Output-to-binding piping (superfluid GDA pools, morpho vaults, pendle markets) remains open. | runnable 228 (was 232; 4 false-runnables became documented skips) | 121 | 8 | unit gate unchanged (goldens regenerated) | Tier 1 re-verification per fix: ~3 min |
| 2026-07-03 | CI alignment: executed-test floor + representatives mode | unchanged | unchanged | unchanged | the protocol step now fails when executed tests drop below 30 (floor verified both ways locally: 185-executed results pass, an all-skipped file trips it) and publishes counts to the step summary; PROTOCOL_E2E_REPRESENTATIVES=1 shrinks each phase to its first runnable action for a future PR-gate/nightly split | workflow changes validated locally: step logic on the rig, structure/gating/job-launch via act (recipe above); parallel-job refactor and the nightly workflow remain follow-ups |
| 2026-07-03 | MetaMorpho unlocks + Tier 1 in CI + nightly | chain-1 sweep 203 pass / 72 skips / 0 fail (stable across consecutive runs): morpho's 18 vault actions bind the live Steakhouse USDC vault (the yearn pattern; no piping needed), core sequence margin-hardened (borrow 10, repay 8, withdraw-collateral 0.02) after one borderline interest-timing failure. Pendle deliberately deferred: its markets expire, so hardcoded bindings rot - needs the state-snapshot fixture approach. Piping now applies only to superfluid GDA (4, blocked on the Sepolia archive upstream). | runnable 246 | 103 | 8 | tier1-simulations job added to the ephemeral workflow (parallel, no app build, floor 150) - per-action breadth reaches CI for the first time; protocol-nightly.yml runs the full e2e via workflow_call plus the Tier 0 mutation check | tier1 CI job ~8 min estimated; workflows actionlinted and act-validated (nightly dry-run traverses both jobs; schedule gate branch exercised) |
| 2026-07-07 | Parallel protocol gate split | unchanged | unchanged | unchanged | protocol-coverage runs as its own job, fed by a shared build-app artifact, in parallel with the e2e stack instead of serially at its tail. PR runs use representatives mode with an executed-test floor of 3 (ajna contributes one read representative and no write - all its writes are skipped; superfluid one read and one write; the mainnet suites self-skip until ANVIL_FORK_MAINNET_URL is provisioned, at which point the floor rises); nightly/push runs keep the full sweep, floor 30. Fork health probes (probe-forks action plus a post-restart upstream probe) guard both anvil forks. First CI round measured: representatives executed 3, passed 3 | protocol results no longer wait on the vitest e2e tail; dead forks or upstreams fail in seconds instead of as 300s vitest timeouts |
| 2026-07-07 | Hermetic fork state for tier1 (RPC fetch cache pivot) | unchanged | unchanged | unchanged | protocol-nightly's fork-cache-mainnet job warms a live pinned fork with the Tier 1 sweep (floor 150; a red sweep or floor breach publishes nothing) and publishes foundry's flushed RPC cache as fork-cache-mainnet-\<block\>.tgz, 3-day retention; the tier1-simulations job consumes the freshest staging-produced artifact under 36 hours old when ANVIL_FORK_MAINNET_URL is set, and falls back to a live fork on every failure mode. The nightly warm sweep runs on a live fork, so it is itself the live-fork canary | the first design (anvil_dumpState + --load-state) was structurally wrong twice over: the dump captured the warm sweep's own mutations (and the sweep is not idempotent on its residue - morpho set-authorization reverts "already set" on re-run, empirically confirmed) and missed eth_call-only fetches. The pivot packages foundry's on-disk RPC fetch cache instead. Measured (foundry:latest, 2026-07-07): anvil persists upstream fetches to $HOME/.foundry/cache/rpc/\<chain\>/\<block\>/storage.json, flushing only on graceful shutdown (SIGTERM; SIGKILL loses it); a fresh fork with the cache mounted at the same pin serves every warmed read with zero upstream requests (counted through a logging proxy) and starts pristine - a warmed impersonated WETH deposit is invisible, totalSupply returns its exact pre-write value; cold reads against a dead upstream fail loudly (-32603); anvil still needs the upstream at startup (chain id, block env) and for the mining loop's block hashes; an unpinned fork also persists a cache keyed by its resolved head block, so pinning stays explicit everywhere |
