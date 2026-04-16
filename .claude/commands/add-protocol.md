---
description: Add a new protocol plugin to KeeperHub via the agent pipeline
argument-hint: <protocol-name-or-spec-file>
---

<objective>
Add a new KeeperHub protocol plugin. $ARGUMENTS is either:
- A protocol name (e.g., "Aave", "Uniswap V3") -- pipeline will gather contract details
- A file path ending in `.md` (e.g., `specs/my-protocol.md`) -- pipeline reads spec file for details
- Empty -- pipeline will ask user what protocol to add

This command invokes the Orchestrator agent which runs the full Blueprint pipeline: DECOMPOSE -> RESEARCH -> IMPLEMENT -> VERIFY -> PR. The pipeline produces a complete, lint-clean, type-safe protocol definition in `protocols/` with tests and documentation.
</objective>

<context>
Domain knowledge: @.claude/agents/protocol-domain.md
Example protocol (ABI-driven, Sepolia integration tests): @protocols/weth.ts
Example protocol (mainnet-only, struct returns, docUrl tooltips): @protocols/aave-v4.ts
Example reduced ABI: @protocols/abis/weth.json
Protocol registry (defineAbiProtocol, defineProtocol): @lib/protocol-registry.ts
ABI derivation: @lib/protocol-abi-derive.ts
Solidity type -> UI field mapping: @lib/solidity-type-fields.ts
Tooltip/docUrl rendering: @lib/extensions.tsx (see ProtocolFieldLabel)
Project conventions: @CLAUDE.md
Blueprint pipeline: @.claude/agents/blueprint-pipeline.md
Existing protocols: !`ls protocols/`
Existing reduced ABIs: !`ls protocols/abis/ 2>/dev/null`
Existing on-chain integration tests: !`ls tests/integration/protocol-*-onchain.test.ts 2>/dev/null`
</context>

<process>
Spawn the Orchestrator agent with the following task description:

```
Protocol Task: Add protocol "$ARGUMENTS" to KeeperHub

Domain Reference: .claude/agents/protocol-domain.md

Task Type: Protocol plugin creation (Tier 1 -- follows existing pattern)

Definition strategy:
- DEFAULT: use `defineAbiProtocol()` with a reduced ABI at `protocols/abis/{slug}.json`. All new protocols use this pattern unless explicitly blocked.
- FALLBACK to `defineProtocol()` only when BOTH: (a) the contract is unverified on every supported explorer, AND (b) no reliable ABI source exists (npm package, GitHub repo, project docs). Document in the PR why the fallback was required.
- For ERC-4626 vaults: keep using `defineProtocol()` + `erc4626VaultActions()` for the vault surface (no ABI-driven helper exists yet).

Required artifacts:
- protocols/{slug}.ts -- protocol definition using defineAbiProtocol() (or defineProtocol() fallback). Every input with a helpTip SHOULD also have a docUrl pointing to canonical protocol docs (enables click-through tooltips). See <field_tooltips> in protocol-domain.md.
- protocols/abis/{slug}.json -- reduced ABI JSON file (ABI-driven path only; skip for fallback). Contains ONLY the functions exposed as actions.
- tests/unit/protocol-{slug}.test.ts -- Vitest unit tests (shape + override integrity)
- tests/integration/protocol-{slug}-onchain.test.ts -- Vitest on-chain integration tests. REQUIRED for all ABI-driven protocols. Gate on INTEGRATION_TEST_RPC_URL (Sepolia, default) or INTEGRATION_TEST_MAINNET_RPC_URL (mainnet-only protocols). One test per action: reads verify decodable output types, writes verify calldata encodes without ABI errors (business reverts are acceptable). See <test_structure> in protocol-domain.md for the full pattern and env-var matrix.
- docs/plugins/{slug}.md -- documentation page
- public/protocols/{slug}.png -- icon (if user provides one)
- Example workflows inserted into local DB via postgres MCP (test workflow per read action + up to 8-10 example workflows, scaled to protocol complexity)

Required modifications:
- docs/plugins/_meta.ts -- add nav entry
- docs/plugins/overview.md -- add to protocols table
- (auto-generated) protocols/index.ts
- (auto-generated) lib/types/integration.ts

Research questions for the Researcher agent:
- What contracts does this protocol have and on which chains?
- For each contract, what is the reduced set of functions to expose? (Provide the ABI fragments for those functions.)
- Does any existing ABI-driven protocol serve as a closer pattern than WETH?
- Does the slug "{slug}" already exist in lib/types/integration.ts or protocols/?
- Does the protocol have Sepolia testnet deployments? If yes, use INTEGRATION_TEST_RPC_URL. If no, use INTEGRATION_TEST_MAINNET_RPC_URL against chain 1.
- Which chains in the protocol's contracts have explorer configs? (Only 1, 8453, 84532, 11155111 -- see protocol-domain.md)
- **Chain scope confirmation (REQUIRED before Builder proceeds):** Compute the intersection of (a) chains where the protocol is deployed and (b) chains KeeperHub supports. Present this list to the user and get explicit confirmation before finalizing the `addresses` map. The chain selector auto-restricts to `Object.keys(contract.addresses)`, so any chain in the map becomes user-selectable -- and any user-selectable chain without a real deployment breaks workflows at runtime.
- **Docs URL discovery:** For each input that needs a helpTip, identify the most specific canonical docs URL (e.g. "supply" page, "borrow" page) from the protocol's official documentation. Prefer stable URLs (official docs) over blog posts. Pass these in the research report so the Builder can populate `docUrl` on overrides.
- Are there unnamed ABI parameters (empty "name") that need `arg0`/`arg1` overrides?
- Does any function require a pre-ABI-encode transform? (Almost always no -- see <encode_transforms> in protocol-domain.md.)
- Does any read function return a struct/tuple? If so, document the component field names so users know what dotted paths are available (`result.fieldName`).

Success criteria:
- protocols/{slug}.ts imports without throwing (defineAbiProtocol validation + ABI derivation pass)
- For ABI-driven path: protocols/abis/{slug}.json parses as valid ABI JSON array
- Chain scope confirmed with user before implementation (list of supported chain IDs in contract.addresses matches user expectation)
- Every input with a helpTip has a docUrl unless no official docs exist (in which case note the absence in the PR description)
- pnpm discover-plugins runs without errors and registers the protocol
- pnpm check passes with zero lint errors
- pnpm type-check passes with zero TypeScript errors
- Vitest unit tests pass: `pnpm test protocol-{slug}`
- Vitest on-chain integration tests pass locally with the appropriate RPC env var set (INTEGRATION_TEST_RPC_URL for Sepolia or INTEGRATION_TEST_MAINNET_RPC_URL for mainnet). Skipped in CI without the env var, safe to commit.
- Documentation page exists with actions table and per-action sections
- Example workflows created via postgres MCP: test workflows (1 per read action) + example workflows (up to 8-10, as many as the protocol's actions meaningfully support)
- All workflows target only chains with explorer configs AND chains defined in the protocol's addresses map
- Code nodes use bare template references (no manual quotes) and divide-by-zero guards
```

The Orchestrator handles: gathering protocol details from user or spec file, decomposing subtasks, delegating to Researcher/Builder/Verifier agents, and creating the PR.
</process>

<success_criteria>
- Orchestrator pipeline completes end-to-end
- Protocol definition at protocols/{slug}.ts passes defineAbiProtocol() (or defineProtocol() fallback) validation
- Reduced ABI at protocols/abis/{slug}.json exists and parses (ABI-driven path only)
- Chain scope explicitly confirmed with user before Builder proceeds
- Input docUrls populated where canonical docs exist
- All checks pass: pnpm check, pnpm type-check, vitest unit tests
- On-chain integration tests at tests/integration/protocol-{slug}-onchain.test.ts pass locally (Sepolia via INTEGRATION_TEST_RPC_URL or mainnet via INTEGRATION_TEST_MAINNET_RPC_URL; skipped in CI, safe to commit)
- PR created targeting staging branch with conventional commit format
- Verifier agent explicitly approved before PR creation (SAFE-04 gate)
- Pipeline safeguards enforced: risk tier classified (SAFE-01), iteration limits tracked (SAFE-02), build verified (SAFE-03)
</success_criteria>
