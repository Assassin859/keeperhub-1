---
description: Add a new protocol plugin to KeeperHub via an iterative agent pipeline
argument-hint: <protocol-name-or-spec-file>
---

<objective>
Add a new KeeperHub protocol plugin and iterate until the on-chain integration tests pass.

`$ARGUMENTS` is one of:
- A protocol name **including the version when multiple versions are live** (e.g. `"Aave V4"`, `"Uniswap V3"`, `"Compound V3"`, `"Pendle"`). The pipeline researches contracts, ABIs, and chains via web search and explorer lookups.
- A path to a spec file ending in `.md`. Pipeline reads it as the source of truth and only researches gaps.
- Empty, or a version-ambiguous name (e.g. just `"Aave"`). Pipeline MUST ask the user which version before researching. Do not default to "the latest" - V3 and V4 of Aave are both in active production use today, and each has its own contracts, ABIs, and slug.

DONE when ALL of the following pass:
- `pnpm test tests/unit/protocol-{slug}.test.ts`
- `pnpm test tests/integration/protocol-{slug}-onchain.test.ts` (against a real RPC for the test chain, OR via the public-RPC-fallback pattern, see `<process>` Phase 4)
- `pnpm check` (Ultracite lint)
- `pnpm type-check` (TypeScript)
- `pnpm discover-plugins` (protocol is registered and `protocols/index.ts` + `lib/types/integration.ts` regenerate cleanly)

The pipeline does NOT exit on partial work. If integration tests do not pass, it loops back to BUILD with the specific failure as the next problem to solve.
</objective>

<context>
Domain knowledge: @.claude/agents/protocol-domain.md
Blueprint pipeline: @.claude/agents/blueprint-pipeline.md
Project conventions: @CLAUDE.md

ABI-driven, Sepolia, 1:1 contract->surface (canonical reference): @protocols/wrapped.ts + @protocols/abis/weth.json
Mainnet-only, struct returns, docUrl tooltips: @protocols/aave-v4.ts
Multi-contract, struct-arg writes: @protocols/uniswap-v3.ts
Hybrid pattern (one ABI backing many UX surfaces; uses `deriveActionsFromAbi` + `defineProtocol`): @protocols/chainlink.ts

Unit test template: @tests/unit/protocol-wrapped.test.ts
Integration test template (Sepolia, gated): @tests/integration/protocol-wrapped-onchain.test.ts
Integration test template (mainnet, gated): @tests/integration/protocol-aave-v4-onchain.test.ts
Integration test template (ungated, public-RPC fallback): @tests/integration/protocol-uniswap-onchain.test.ts

Protocol registry: @lib/protocol-registry.ts
ABI derivation internals: @lib/abi/protocol-derive.ts
Solidity type to field mapping: @lib/solidity-type-fields.ts
Tooltip/docUrl rendering: @lib/extensions.tsx (see `ProtocolFieldLabel`)

Existing protocols: !`ls protocols/`
Existing reduced ABIs: !`ls protocols/abis/ 2>/dev/null`
Existing integration tests: !`ls tests/integration/protocol-*-onchain.test.ts 2>/dev/null`
</context>

<process>
Spawn the Orchestrator agent with the iteration loop below. The Orchestrator MUST NOT exit until DONE (see `<objective>`) or a hard bail-out condition is hit.

```
Protocol Task: Add protocol "$ARGUMENTS" to KeeperHub via the iterative pipeline.

Domain Reference: .claude/agents/protocol-domain.md

ITERATION LOOP

Phases run in order. After VERIFY, if any check failed, loop back to BUILD with the specific failure as the next problem. Do not silently exit on partial work.

PHASE 1 - RESEARCH (web search + explorer lookups, BEFORE any code is written)

Use WebSearch and WebFetch to gather concrete facts. Cite URLs and addresses for every claim. Do not guess; if a fact cannot be confirmed, mark it open and surface to the user.

1.1 Identity and version (do this FIRST; everything downstream depends on getting the version right)
- Canonical name and 1-line description of what the protocol does.
- **Version**: which specific version of the protocol is being added? Aave V2/V3/V4, Uniswap V2/V3/V4, Compound V2/V3, the Maker -> Sky rebrand, etc. Confirm the exact version explicitly. Do not assume "the latest" or "the most common" - the live deployments answer this, not your priors.
- Slug convention based on existing protocols in `protocols/`:
  - When multiple versions of the protocol are supported in this codebase as separate entries, the slug encodes the version: `aave-v3`, `aave-v4`.
  - When only one version is supported, the slug omits the version: `compound`, `uniswap`, `yearn` (file is named `compound-v3.ts` etc., but slug is bare). This is intentional - users see "Compound", not "Compound V3", in the workflow builder when no other version is exposed.
  - Decide which case applies based on whether you are adding alongside an existing version of the same protocol.
- Official website.
- Confirm the chosen slug does not collide with any entry in `protocols/` or `lib/types/integration.ts`.

1.2 Chains
- Which chains is the protocol deployed on?
- Intersect with KeeperHub's supported chains. Source of truth: existing protocols in `protocols/` and the chain entries in `chain-config/`. Any chain not in `chain-config/` will not have an explorer config and cannot be used.
- Report the intersection. That is the candidate `addresses` map.

1.3 Contracts
- For each contract the user will interact with: label, address per chain, and the curated function set to expose.
- **Version isolation**: every contract MUST belong to the version identified in Phase 1.1. Do not mix V3 and V4 contracts in one protocol entry. When a version has sub-surfaces (Aave V4 Hub vs Spoke, Uniswap V3 SwapRouter02 vs older SwapRouter, Maker DSR vs Sky Savings Rate), name the exact surface in the contract label.
- Curate aggressively. Exposing every public function bloats the UI; pick the actions a user actually wants to run.
- Flag any contract whose address is per-user input (e.g. user supplies a pool address); these set `userSpecifiedAddress: true`.

1.4 ABI
- Obtain a reduced ABI for each contract. Source order of preference:
  a. npm package shipped by the protocol team **for the target version** (use the latest tagged release of that version's package, not main, not a different version's package).
  b. Verified contract on the relevant block explorer (Etherscan-style "Contract" tab). The explorer page MUST be for the version's deployment address from Phase 1.3 - confirm before copying the ABI. A V3 ABI scraped from a V4 contract page (or vice versa) will compile, pass unit tests, and fail integration tests with `INVALID_ARGUMENT` or `BAD_DATA`.
  c. Protocol's GitHub repo (look under `abi/`, `artifacts/`, or `out/` for forge projects). Pin to the version's tag or release branch, not `main` or `master`.
  d. Official protocol docs.
- **ABI-to-version match is a hard gate.** Function signatures drift between versions (Aave V3 `supply(asset, amount, onBehalfOf, referralCode)` becomes V4 `supply(reserveId, amount, onBehalfOf)`). The integration tests in Phase 4 will catch a version mismatch, but the cost is one or more failed iterations. Cite the exact source URL for each ABI in the Phase 2 report so reviewers can verify the version match before any code is written.
- Reduce: keep only the functions and events being exposed. Drop everything else.

1.5 Documentation URLs
- For each function being exposed, identify the canonical per-page docs URL. This populates `docUrl` on overrides.
- Prefer per-function pages over the docs root. Skip docUrl rather than link to a non-canonical page (blog, third-party tutorial).

1.6 Definition strategy (pick ONE; record why)
- DEFAULT: `defineAbiProtocol()` with one reduced ABI per contract.
- HYBRID: `defineProtocol()` with `...deriveActionsFromAbi(...)` spread into the actions array. Use when one ABI backs many distinct UX surfaces (price feeds, per-asset markets, curated bundles). Reference: `protocols/chainlink.ts`.
- FALLBACK: pure `defineProtocol()`. ONLY when no ABI source exists anywhere. Document the unavailability in the PR.
- ERC-4626 vaults: `defineProtocol()` + `erc4626VaultActions()` (no ABI-driven helper yet).

PHASE 2 - CONFIRM (gate: do NOT proceed without explicit user approval)

Post a research report to the user containing:
- Protocol: name, **version**, slug, 1-line description. State the version prominently; do not bury it.
- Chains: intersection list with rationale for each inclusion/exclusion.
- Contracts: table of label / function set / source ABI URL / docs URL. All contracts belong to the named version only.
- Definition strategy + why this one fits.
- ABI source(s) per contract, with the version each ABI corresponds to and the exact URL it came from.

WAIT for explicit user confirmation on chains AND contracts. If the user says "add chain X" or "drop function Y", loop back to Phase 1 with the adjustment. Do not begin writing code.

Rationale: the chain selector auto-restricts to `Object.keys(contract.addresses)`. Any chain in the map becomes user-selectable in the workflow builder, and any user-selectable chain without a real deployment breaks workflows at runtime. This gate exists to prevent that class of bug.

PHASE 3 - BUILD

Once Phase 2 is confirmed, produce these files. For each, match the structure of the example called out:

- `protocols/{slug}.ts` - protocol definition. Match the example file picked in Phase 1.6.
- `protocols/abis/{slug}.json` (or `{slug}-{contract}.json` if multiple contracts) - reduced ABI(s). Functions plus only the events being exposed. Nothing else.
- `tests/unit/protocol-{slug}.test.ts` - shape and override integrity. Model on `tests/unit/protocol-wrapped.test.ts`. Cover at minimum:
  - Default export imports without throwing; name and slug correct.
  - Protocol slug matches kebab-case regex.
  - All action slugs match kebab-case regex.
  - Every action's `contract` references a defined contract key.
  - No duplicate action slugs (the registry does NOT check this; the unit test is the safety net).
  - Every read action has non-empty `outputs`.
  - Every contract address matches `^0x[0-9a-fA-F]{40}$`.
  - Action count + slugs (shape lock so future edits surface intent changes).
  - Per-action: function name, payable flag, input names/types/labels/helpTip/docUrl, output names/labels/decimals.
  - Chain coverage list - both inclusions AND explicit exclusions (e.g. `expect(chains).not.toContain("10")` for a gap).
  - Registry round-trip: `registerProtocol(def)` then `getProtocol(slug)`.
- `tests/integration/protocol-{slug}-onchain.test.ts` - calldata validation. Model on whichever of these matches the protocol's deployment:
  - Sepolia testnet deployment: `tests/integration/protocol-wrapped-onchain.test.ts` (gated on `INTEGRATION_TEST_RPC_URL`).
  - Mainnet-only deployment: `tests/integration/protocol-aave-v4-onchain.test.ts` (gated on `INTEGRATION_TEST_MAINNET_RPC_URL`).
  - Reliable public RPC available AND test should run in CI without secrets: `tests/integration/protocol-uniswap-onchain.test.ts` (ungated; uses `CHAIN_RPC_CONFIG` resolver with public-RPC fallback). Default to gated unless there is a specific reason.
  - All three patterns require: `vi.mock("server-only", () => ({}));` at the top. RPC routed through `getRpcProviderFromUrls` + `executeWithFailover` (same failover the prod request path uses). One test per exposed action: reads decode the return type; writes call `estimateGas` or `provider.call` and accept `CALL_EXCEPTION` (business revert) while rejecting ABI errors (see Phase 4).
- `docs/plugins/{slug}.md` - public docs page with actions table and per-action sections.
- `docs/plugins/_meta.ts` - add nav entry.
- `docs/plugins/overview.md` - add to protocols table.
- `public/protocols/{slug}.png` - icon. Skip if the user did not provide one; do not block on this.

Auto-generated (do NOT hand-edit):
- `protocols/index.ts` - regenerated by `pnpm discover-plugins`.
- `lib/types/integration.ts` - slug appended by discover-plugins.

User-visible string formatting (HARD RULE):
- `description`, `label`, and `helpTip` strings on the protocol, actions, inputs, and outputs MUST NOT contain em dashes or double-hyphens (`--`). Use periods, colons, semicolons, or restructure the sentence. Hyphens inside compound words (e.g. `pro-rata`, `wei/sec`, `CFA+GDA`) are fine; the rule is specifically about the dash-as-clause-separator pattern.
- Applies equally to the docs/plugins/{slug}.md page.

PHASE 4 - VERIFY

Run in order. Do NOT advance past a failing step. Re-run the FULL sequence after every fix (do not assume earlier passes still pass).

4.1 `pnpm discover-plugins` exits 0 and registers the protocol (check stdout includes the new slug; check `protocols/index.ts` was regenerated).
4.2 `pnpm check` passes.
4.3 `pnpm type-check` passes.
4.4 `pnpm test tests/unit/protocol-{slug}.test.ts` passes.
4.5 `pnpm test tests/integration/protocol-{slug}-onchain.test.ts` passes against a real RPC. RPC selection by gating pattern:
  - `INTEGRATION_TEST_RPC_URL` set to a Sepolia RPC (gated Sepolia tests).
  - `INTEGRATION_TEST_MAINNET_RPC_URL` set to a mainnet RPC (gated mainnet tests).
  - No env var needed for ungated tests; the public-RPC fallback will be used.
  - If the required env var is unset, the test SKIPS, which counts as "did not pass". The Orchestrator must ask the user to provide the RPC URL (or accept the ungated pattern) before declaring DONE.

When a check fails, classify and resolve:
- Lint / type / shape failure -> patch the source file or the unit test, depending on which is wrong. Tests encode intent; if the intent was wrong, update both.
- Integration test ABI errors (`INVALID_ARGUMENT`, `BAD_DATA`, `BUFFER_OVERRUN`, `"could not decode"`, `"invalid function"`) -> the reduced ABI does NOT match the deployed bytecode. Fix the ABI. Do NOT loosen the test.
- Integration test `CALL_EXCEPTION` on a write action -> ACCEPT. A business revert (zero allowance, nonexistent reserve, missing approval) still proves the bytecode parsed the calldata. Document the revert in a comment if it is non-obvious.
- Integration test `CALL_EXCEPTION` on a read action -> investigate. Reads should not revert unless the calldata is wrong (e.g. calling `balanceOf` on a non-token).

Loop back to PHASE 3 with the specific failure as the problem to solve. Do not declare DONE until all five checks pass cleanly.

PHASE 5 - EXIT

Once Phase 4 passes:
- Summarise: protocol slug, contracts, chains, action count, definition strategy used.
- Draft PR title and body, conventional commit format (e.g. `feat: KEEP-XXX add <Protocol> protocol plugin`). Branch `feat/KEEP-XXXX-add-{slug}` if a Linear ticket is set; else `feat/add-{slug}-protocol`.
- DO NOT create the PR. User confirmation is required per CLAUDE.md ("Do not git push or create GitHub PRs without user's confirmation").

BAIL-OUT CONDITIONS (stop the loop and surface to user):
- The same integration test failure recurs across 3 consecutive iterations.
- Research surfaces a chain / contract requirement that conflicts with the Phase 2 confirmation - re-confirm before proceeding.
- No ABI source can be obtained from any explorer, npm package, GitHub repo, or official docs - escalate; do not invent ABI fragments.
- **Version ambiguity**: $ARGUMENTS does not uniquely identify a version (e.g. just `"Aave"` when V3 and V4 are both live), OR research surfaces a candidate ABI / contract whose version cannot be confirmed. Surface the available versions to the user and wait for disambiguation. Do not pick a default.

On bail-out, surface to the user:
- Current state of all generated files.
- The specific failure that blocked progress (full error text, not a summary).
- A concrete question to unblock (not "what should I do?", but e.g. "Pendle's `redeemPY` returns a struct with a `bytes32` field that decodes as a malformed tuple - should I expose this as a single struct field or flatten with named field overrides?").
```

The Orchestrator handles: web search, decomposing subtasks, delegating to Researcher / Builder / Verifier agents, running the iteration loop, and drafting the PR.
</process>

<success_criteria>
- Integration tests at `tests/integration/protocol-{slug}-onchain.test.ts` pass against the configured RPC (skipped is not pass).
- Unit tests at `tests/unit/protocol-{slug}.test.ts` pass.
- `pnpm check`, `pnpm type-check`, `pnpm discover-plugins` all exit 0.
- Chain and contract scope was explicitly confirmed by the user in Phase 2 before any code was written.
- Definition strategy is justified in the PR description (which of defineAbiProtocol / hybrid / fallback was used and why).
- Input docUrls populated for every input where a canonical per-page docs URL exists; absences noted in the PR.
- PR drafted but not created; user confirmation required to push and open.
</success_criteria>
