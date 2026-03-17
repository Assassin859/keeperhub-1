<overview>
Protocol plugins are "meta-plugins" that define DeFi protocol interactions declaratively.

- Protocols go in `protocols/` as `{slug}.ts` files
- Each file uses `defineProtocol()` from `@/lib/protocol-registry`
- `pnpm discover-plugins` generates the barrel (`protocols/index.ts`) and registers to `lib/types/integration.ts`
- The generic protocol-read/protocol-write step handlers route to the correct contract/function via `_protocolMeta` JSON injected into action config
- If any protocol definition fails validation, the entire import chain fails and the server won't start
- Each protocol slug becomes its own `IntegrationType` entry (e.g., `"weth"`, `"sky"`)
</overview>

<api_shape>
Complete `defineProtocol()` TypeScript shape:

```typescript
import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: string,           // Display name (e.g., "Sky Protocol")
  slug: string,           // kebab-case (e.g., "sky") -- matches filename without .ts
  description: string,    // One-line description of the protocol
  website?: string,       // Protocol website URL (optional)
  icon?: string,          // Path like "/protocols/sky.png" -- optional, default icon shown if omitted

  contracts: Record<string, {
    label: string,
    addresses: Record<string, string>,  // chainId string -> 0x-prefixed hex address (exactly 42 chars)
    abi?: string,                       // OMIT for auto-fetch (recommended -- see abi_handling)
    userSpecifiedAddress?: boolean,     // When true, runtime address comes from user input (see user_specified_address)
  }>,

  actions: Array<{
    slug: string,           // kebab-case (e.g., "deposit-ssr", "get-balance")
    label: string,          // User-facing label (e.g., "Deposit USDS to Savings")
    description: string,    // What the action does (one sentence)
    type: "read" | "write", // read = view/pure functions, write = state-changing transactions
    contract: string,       // MUST exactly match a key in the contracts object above
    function: string,       // Exact Solidity function name (e.g., "deposit", "balanceOf")
    inputs: Array<{
      name: string,         // Exact Solidity parameter name
      type: string,         // MUST be a valid Solidity type: address, uint256, int256, bytes32, bool, string, bytes, uint8, etc.
      label: string,        // User-facing label shown in workflow builder
      default?: string,     // Default value as string (optional)
      decimals?: boolean | number,  // true = 18 decimals, number = specific decimals
    }>,
    outputs?: Array<{       // REQUIRED for read actions that return values. Omit for write actions.
      name: string,         // Output field name (used as {{NodeId.fieldName}} in templates)
      type: string,         // Solidity return type
      label: string,        // User-facing label
      decimals?: number,    // Decimal places for display
    }>,
  }>,
})
```
</api_shape>

<validation_rules>
Rules enforced by `defineProtocol()` at import time (violations throw at startup):

- Protocol slug must match `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/` (kebab-case, start with letter)
- Action slugs must match the same pattern
- Contract addresses must match `/^0x[0-9a-fA-F]{40}$/` (exactly 42 chars, 0x prefix)
- Every `action.contract` value must reference an existing key in the `contracts` object
- At least one contract required
- At least one action required
- No duplicate action slugs
</validation_rules>

<chain_ids>
Supported chains with their numeric string keys:

- "1" -- Ethereum Mainnet
- "8453" -- Base
- "42161" -- Arbitrum One
- "10" -- Optimism
- "11155111" -- Sepolia Testnet
</chain_ids>

<abi_handling>
- OMIT the `abi` field from all contract definitions (recommended)
- `resolveAbi()` auto-fetches from block explorers (Etherscan, BaseScan, Arbiscan) with 24h cache
- Proxy detection is automatic: EIP-1967, EIP-1822, EIP-2535 (Diamond) -- ABI follows the implementation
- Only provide inline `abi` if: contract is unverified on all explorers AND you have the ABI string
- Add a comment noting proxy status: `// Proxy -- ABI auto-resolved via abi-cache`
</abi_handling>

<erc4626_vault_standard>
ERC-4626 is the tokenized vault standard. Many DeFi protocols implement ERC-4626 for savings/staking vaults (e.g., sUSDS, sDAI). A shared module at `lib/standards/erc4626.ts` provides standardized vault actions.

How to detect ERC-4626 compliance:
- The contract implements `deposit(uint256,address)`, `mint(uint256,address)`, `withdraw(uint256,address,address)`, `redeem(uint256,address,address)`, `asset()`, `totalAssets()`, `convertToAssets(uint256)`, `convertToShares(uint256)`, `previewDeposit(uint256)`, `previewMint(uint256)`, `previewWithdraw(uint256)`, `previewRedeem(uint256)`, `maxDeposit(address)`, `maxMint(address)`, `maxWithdraw(address)`, `maxRedeem(address)`, `balanceOf(address)`, `totalSupply()`
- The protocol documentation or contract source explicitly states ERC-4626 compliance
- The contract inherits from OpenZeppelin's ERC4626 or a similar implementation

Usage in protocol definitions:
```typescript
import { defineProtocol } from "@/lib/protocol-registry";
import { erc4626VaultActions } from "@/lib/standards/erc4626";

export default defineProtocol({
  // ...
  actions: [
    ...erc4626VaultActions("vaultContractKey"),  // Spread 18 standard vault actions
    // Protocol-specific non-vault actions below
  ],
});
```

The `erc4626VaultActions(contract, options?)` function returns 18 `ProtocolAction[]` items:
- 4 write: vault-deposit, vault-mint, vault-withdraw, vault-redeem
- 14 read: vault-asset, vault-total-assets, vault-total-supply, vault-balance, vault-convert-to-assets, vault-convert-to-shares, vault-preview-deposit, vault-preview-mint, vault-preview-withdraw, vault-preview-redeem, vault-max-deposit, vault-max-mint, vault-max-withdraw, vault-max-redeem

Options: `{ slugPrefix?, labelPrefix?, decimals? }`. Use `decimals` for non-18-decimal vaults (e.g., USDC = 6).

All slugs are prefixed with `vault-` to avoid collisions with protocol-specific actions.

When NOT to use the shared standard:
- The vault uses custom/non-standard function signatures (e.g., Ajna vaults with `drain`, `move`, `moveFromBuffer`)
- The vault only partially implements ERC-4626 (missing required functions)
- The protocol wraps ERC-4626 with additional parameters not in the standard interface

Protocols that SHOULD use erc4626VaultActions:
- Sky (sUSDS vault) -- contract key: "sUsds"
- Spark (sDAI vault) -- contract key: "sdai"
- Any future protocol with an ERC-4626 compliant vault

Protocols that should NOT use it:
- Ajna (custom vault functions, not ERC-4626 compliant)

Slug migration note: When porting an existing protocol to use `erc4626VaultActions`, action slugs change (e.g., `deposit-ssr` becomes `vault-deposit`). Existing workflows referencing old slugs need a database migration to update the `actionType` field in workflow nodes. Include migration SQL in the PR description.
</erc4626_vault_standard>

<user_specified_address>
For protocols with user-specific addresses (e.g., Safe multisig):

- Set `userSpecifiedAddress: true` on the contract
- The `addresses` field serves as chain-availability metadata -- use reference addresses (e.g., singleton/implementation addresses) so `collectAllChains()` in the UI correctly shows supported chains
- At build time, `buildConfigFieldsFromAction()` auto-inserts a `contractAddress` template-input field
- At runtime, `protocol-read.ts` and `protocol-write.ts` read `input.contractAddress` instead of looking up from the fixed addresses map
- Reference: `protocols/safe.ts` (canonical example)
</user_specified_address>

<icon_handling>
- Icon is optional -- if omitted, default square protocol icon (`ProtocolIcon`) is displayed
- If URL provided: `curl -sL -o public/protocols/{slug}.png "{url}"`
- If local path provided: `cp {path} public/protocols/{slug}.png`
- Source images must be at least 256x256 for retina display (component renders at 48x48 via Next.js Image)
- Preferred: Trust Wallet assets at `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/{checksumAddress}/logo.png`
- If no icon provided: OMIT the `icon` field entirely from the definition -- do not set it to empty string or null
</icon_handling>

<output_fields>
Auto-added output fields -- do NOT define these manually:

- All actions get: `success` (boolean), `error` (string)
- Write actions get: `transactionHash`, `transactionLink`
- Read actions MUST define `outputs` array if the function returns values
- Output field count and order MUST exactly match the contract function's return values
- Declaring extra outputs causes silent data corruption (values shift or are undefined)
</output_fields>

<registration>
Post-creation steps in this exact order:

1. `pnpm discover-plugins` -- generates barrel and registers to integration types
2. `pnpm check` -- lint check
3. `pnpm type-check` -- TypeScript validation

NEVER manually edit `protocols/index.ts` or `lib/types/integration.ts` -- these are auto-generated.
</registration>

<weth_reference>
Canonical WETH example -- 5 chains, 3 actions (wrap, unwrap, balance-of):

```typescript
import { defineProtocol } from "@/lib/protocol-registry";

export default defineProtocol({
  name: "WETH",
  slug: "weth",
  description: "Wrapped Ether -- wrap ETH to WETH (ERC-20) and unwrap back to ETH",
  website: "https://weth.io",
  icon: "/protocols/weth.png",

  contracts: {
    weth: {
      label: "WETH Contract",
      addresses: {
        // Ethereum Mainnet
        "1": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        // Base
        "8453": "0x4200000000000000000000000000000000000006",
        // Arbitrum One
        "42161": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        // Optimism
        "10": "0x4200000000000000000000000000000000000006",
        // Sepolia Testnet
        "11155111": "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
  },

  actions: [
    {
      slug: "wrap",
      label: "Wrap ETH",
      description: "Wrap native ETH into WETH (ERC-20). Send ETH value with the transaction.",
      type: "write",
      contract: "weth",
      function: "deposit",
      inputs: [],
    },
    {
      slug: "unwrap",
      label: "Unwrap WETH",
      description: "Unwrap WETH back to native ETH",
      type: "write",
      contract: "weth",
      function: "withdraw",
      inputs: [{ name: "wad", type: "uint256", label: "Amount (wei)" }],
    },
    {
      slug: "balance-of",
      label: "Get Balance",
      description: "Check WETH balance of an address",
      type: "read",
      contract: "weth",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "WETH Balance (wei)",
          decimals: 18,
        },
      ],
    },
  ],
});
```
</weth_reference>

<known_issues>
Critical runtime issues agents must not break:

1. `_protocolMeta` persistence: The protocol detail page must explicitly include `_protocolMeta` in node config -- this is already handled in `protocol-detail.tsx`. Do NOT remove that code.

2. `_actionType` fallback: Protocol step handlers derive metadata from `_actionType` (e.g., `"sky/get-usds-balance"`) via `resolve-protocol-meta.ts`. Do NOT inline that logic back into step files.

3. Cognitive complexity: Protocol step functions are near the Biome limit (15). The metadata resolution was extracted to `resolve-protocol-meta.ts`. Do NOT inline it back.

4. "use step" bundler constraints: Protocol step files have `"use step"` -- NEVER export helper functions from them. Shared logic goes in separate files without `"use step"` (e.g., `resolve-protocol-meta.ts`).

5. Proxy contract ABI resolution: The `hasFunctions` check in `fetchAbiFromExplorer()` is required -- do NOT remove it. Proxy contracts return valid ABI from Etherscan but with only constructor/error/event/fallback entries and no functions.

6. Icon rendering quality: Source images must be at least 256x256 for crisp retina display. Prefer Trust Wallet assets as primary source.
</known_issues>

<documentation_structure>
ALWAYS create documentation when adding a new protocol or feature. This is a required step in the creation workflow.

Format for `docs/plugins/{slug}.md` protocol documentation:

- Frontmatter: title, description
- H1, overview paragraph, supported chains
- Actions table with columns: Action, Type, Credentials, Description
- Per-action H2 sections with Inputs, Outputs, When to use
- Example Workflows section (2-4 practical multi-step workflow examples)
- "Supported Chains" section

Also update:
- `docs/plugins/_meta.ts` -- add protocol entry in alphabetical order
- `docs/plugins/overview.md` -- add row to protocols table
</documentation_structure>

<test_structure>
Format for `tests/unit/protocol-{slug}.test.ts` using Vitest. Tests to include:

- Definition validity (import does not throw)
- Slug format (protocol + all action slugs match pattern)
- Address format (all addresses are 42-char hex)
- Contract references (all action.contract values exist in contracts)
- No duplicate action slugs
- Read action outputs (every read action with return values has outputs defined)
- Action count matches expected
- Registration check (use `getProtocol("{slug}")`)
</test_structure>

<explorer_chain_availability>
Only chains with block explorer configs support ABI auto-fetch. Workflows targeting chains without explorer configs will fail silently at runtime when resolveAbi() cannot fetch the ABI.

EVM chains with Etherscan-compatible explorer configs (safe for seed workflows):
- "1" -- Ethereum Mainnet (Etherscan)
- "8453" -- Base (BaseScan)
- "84532" -- Base Sepolia (BaseScan testnet)
- "11155111" -- Sepolia Testnet (Etherscan Sepolia)

Non-EVM / Blockscout chains with explorer configs (NOT safe for protocol seed workflows -- different API format):
- "42420" -- Tempo (Blockscout)
- "42429" -- Tempo Testnet (Blockscout)
- "101" -- Solana (Solscan)
- "103" -- Solana Devnet (Solscan)

EVM chains WITHOUT explorer configs (ABI auto-fetch fails):
- "42161" -- Arbitrum One
- "10" -- Optimism

Rules:
- Seed/example workflows MUST only target EVM chains with Etherscan-compatible explorer configs unless the protocol provides an inline `abi` field
- When a protocol supports multiple chains, default to chain "1" (Ethereum Mainnet) for seed workflows
- Update this section when new explorer configs are added to the codebase
</explorer_chain_availability>

<code_node_patterns>
Rules for Code nodes in workflows. Violations cause silent runtime failures.

Action type:
- Code nodes MUST use `actionType: "code/run-code"` -- NOT `"Code"`
- The workflow executor in `lib/workflow-executor.workflow.ts` checks `actionType === "code/run-code"` in the action dispatch logic
- Using `"Code"` causes the node to be treated as an unknown action, breaking the workflow silently

Node label restrictions:
- Node labels MUST NOT contain colons (`:`) -- the template syntax `{{@nodeId:Label.field}}` uses `:` as the separator between nodeId and Label. A label like `"Lido: Get stETH"` breaks the parser because it sees `Lido` as the label and `Get stETH.result` as the field.
- CORRECT: `"Get wstETH Rate"`, `"Read ETH Price"`, `"Format Dashboard"`
- WRONG: `"Lido: Get stETH per wstETH"`, `"Chronicle: Read Oracle Value"`, `"Compound: USDC Supply Rate"`
- This applies to ALL nodes whose outputs are referenced by downstream template variables, not just Code nodes

Template quoting:
- `formatCodeValue()` in `lib/workflow-executor.workflow.ts` already wraps string values via `JSON.stringify()` before injecting them into the Code node sandbox
- CORRECT: `const x = {{@nodeId:Label.result}};` -- no manual quotes needed, becomes `const x = "value";`
- WRONG: `const x = "{{@nodeId:Label.result}}";` -- produces `const x = ""value""` which is a JS syntax error
- For numbers: `Number({{@nodeId:Label.result}})` works correctly (becomes `Number("123")`)

Divide-by-zero guards:
- All percentage and ratio calculations in Code nodes MUST guard against divide-by-zero
- Pattern: `const pct = total > 0 ? ((val / total) * 100).toFixed(2) : "0.00";`
- Applies to any expression with division where the denominator comes from a template reference or computed value

Value formatting:
- Use `Intl.NumberFormat` for formatting token amounts and prices (available in Code node VM sandbox via `Intl` global)
- Pattern: `new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)`
- For USD prices: `new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)`
- Prefer `Intl.NumberFormat` over `.toLocaleString()` for consistency and explicit control
</code_node_patterns>

<example_workflow_generation>
The pipeline creates example workflows directly in the local postgres DB using the postgres MCP (`mcp__postgres__execute_sql`). Do NOT create TypeScript seed scripts in `scripts/seed/`. Use SQL INSERTs via MCP so workflows are created immediately and can be verified in the app. Never use the KeeperHub MCP for this -- workflows stay local only.

Steps:
1. Query for the local dev user and org:
   ```sql
   SELECT u.id AS user_id, m.organization_id
   FROM users u JOIN member m ON m.user_id = u.id LIMIT 1;
   ```
2. Create a project (idempotent). Use dollar-quoting (`$$`) for string values that may contain single quotes:
   ```sql
   INSERT INTO projects (id, name, description, organization_id, user_id)
   VALUES ($$proj-{slug}$$, $${Protocol Name}$$, $${description}$$, $${org_id}$$, $${user_id}$$)
   ON CONFLICT (id) DO NOTHING;
   ```
3. Insert each workflow with a single INSERT. The `nodes` and `edges` columns are JSONB.
   ```sql
   INSERT INTO workflows (id, name, description, user_id, organization_id, project_id, visibility, featured, featured_protocol, featured_protocol_order, nodes, edges)
   VALUES (
     '{generate-unique-id}',
     '{workflow name}',
     '{workflow description}',
     '{user_id}',
     '{org_id}',
     'proj-{slug}',
     'public',     -- 'private' for test workflows
     true,         -- false for test workflows
     '{slug}',     -- null for test workflows
     1,            -- sequential order, null for test workflows
     '{nodes_json}'::jsonb,
     '{edges_json}'::jsonb
   );
   ```

CRITICAL: Every node config MUST include ALL required fields for its action type. Incomplete nodes break workflows silently at runtime. The canonical reference for each node type is below -- follow these exactly.

Referencing outputs from upstream nodes:
- Protocol read actions (single return): `{{@read-node:Read Label.result}}` -- the raw value is stored as `result`
- Code node outputs: `{{@code-node:Code Label.result.myField}}` -- Code step returns `{ success, result, logs }`, so fields are nested under `result`
- WRONG for Code: `{{@code-node:Code Label.myField}}` -- resolves to undefined (top-level keys are `success`, `result`, `logs`)
- Write action outputs: `{{@write-node:Write Label.transactionHash}}`, `{{@write-node:Write Label.transactionLink}}`, `{{@write-node:Write Label.success}}`, `{{@write-node:Write Label.error}}`

Node structure reference -- ALL required fields shown for each type:

**Trigger node -- Manual:**
```json
{
  "id": "trigger-1",
  "type": "trigger",
  "position": {"x": 100, "y": 250},
  "data": {
    "type": "trigger",
    "label": "Manual Trigger",
    "config": {"triggerType": "Manual"},
    "status": "idle",
    "description": "Run manually"
  }
}
```

**Trigger node -- Schedule (required fields: triggerType, scheduleCron, scheduleTimezone):**
```json
{
  "id": "trigger-1",
  "type": "trigger",
  "position": {"x": 100, "y": 250},
  "data": {
    "type": "trigger",
    "label": "Hourly Schedule",
    "config": {
      "triggerType": "Schedule",
      "scheduleCron": "0 * * * *",
      "scheduleTimezone": "UTC"
    },
    "status": "idle",
    "description": "Check every hour"
  }
}
```
WRONG: `"cron": "0 * * * *"` -- this field is ignored. MUST use `scheduleCron`.
WRONG: omitting `scheduleTimezone` -- defaults are unreliable, always set `"UTC"`.

**Protocol read action node (required fields: actionType, network, _protocolMeta, plus all action inputs):**

Example with no inputs (parameterless read like `getExchangeRate`):
```json
{
  "id": "read-rate",
  "type": "action",
  "position": {"x": 350, "y": 250},
  "data": {
    "type": "action",
    "label": "Get rETH Exchange Rate",
    "description": "Get the current ETH value of 1 rETH",
    "config": {
      "actionType": "{slug}/{action-slug}",
      "network": "1",
      "_protocolMeta": "{\"protocolSlug\":\"{slug}\",\"contractKey\":\"reth\",\"functionName\":\"getExchangeRate\",\"actionType\":\"read\"}"
    },
    "status": "idle"
  }
}
```

Example with inputs (read like `balanceOf(address)`):
```json
{
  "id": "read-balance",
  "type": "action",
  "position": {"x": 350, "y": 250},
  "data": {
    "type": "action",
    "label": "Get Token Balance",
    "description": "Check token balance of an address",
    "config": {
      "actionType": "{slug}/{action-slug}",
      "network": "1",
      "_protocolMeta": "{\"protocolSlug\":\"{slug}\",\"contractKey\":\"token\",\"functionName\":\"balanceOf\",\"actionType\":\"read\"}",
      "account": "0x..."
    },
    "status": "idle"
  }
}
```
- `actionType`: MUST be `{protocol-slug}/{action-slug}` (e.g., `"rocket-pool/get-reth-exchange-rate"`)
- `network`: chain ID string (e.g., `"1"` for mainnet) -- MUST be a chain with explorer config
- `_protocolMeta`: JSON string with `protocolSlug`, `contractKey`, `functionName`, `actionType` -- MUST match the protocol definition exactly
- All action inputs from the protocol definition MUST be present as config fields (e.g., `"account"` for `balanceOf`). Omit input fields for parameterless actions.
- For `userSpecifiedAddress` contracts: add `"contractAddress": "0x..."` field

**Protocol write action node (required fields: actionType, network, _protocolMeta, plus all action inputs):**
```json
{
  "id": "deposit-eth",
  "type": "action",
  "position": {"x": 600, "y": 250},
  "data": {
    "type": "action",
    "label": "Deposit ETH for rETH",
    "description": "Deposit ETH into Rocket Pool",
    "config": {
      "actionType": "{slug}/deposit",
      "network": "1",
      "_protocolMeta": "{\"protocolSlug\":\"{slug}\",\"contractKey\":\"depositPool\",\"functionName\":\"deposit\",\"actionType\":\"write\"}"
    },
    "status": "idle"
  }
}
```

**Code node (required fields: actionType, code):**
```json
{
  "id": "fmt",
  "type": "action",
  "position": {"x": 600, "y": 250},
  "data": {
    "type": "action",
    "label": "Format Rate",
    "description": "Convert raw wei exchange rate to human-readable decimal",
    "config": {
      "actionType": "code/run-code",
      "code": "const raw = Number({{@read-rate:Get rETH Exchange Rate.result}});\nconst rate = raw / 1e18;\nconst formatted = new Intl.NumberFormat(\"en-US\", { maximumFractionDigits: 6 }).format(rate);\nreturn { rate: rate.toFixed(6), formatted, raw: String(raw) };"
    },
    "status": "idle"
  }
}
```
- `actionType` MUST be `"code/run-code"` -- NOT `"Code"` (see `<code_node_patterns>`)
- Template refs: NO manual quotes (see `<code_node_patterns>`)
- ALL division MUST have divide-by-zero guards
- Use `Intl.NumberFormat` for formatting

**Condition node (required fields: actionType, condition, conditionConfig with group/rules):**
```json
{
  "id": "cond-peg",
  "type": "action",
  "position": {"x": 850, "y": 250},
  "data": {
    "type": "action",
    "label": "Rate >= 1.0 ETH?",
    "description": "Check rETH rate is at or above 1.0 ETH (healthy peg)",
    "config": {
      "actionType": "Condition",
      "condition": "{{@fmt:Format Rate.result.rate}} >= 1",
      "conditionConfig": {
        "group": {
          "id": "rate-check-1",
          "logic": "AND",
          "rules": [
            {
              "id": "rule-rate-ok",
              "operator": ">=",
              "leftOperand": "{{@fmt:Format Rate.result.rate}}",
              "rightOperand": "1"
            }
          ]
        }
      }
    },
    "status": "idle"
  }
}
```
- MUST include BOTH `condition` (legacy string) AND `conditionConfig` (structured rules)
- `conditionConfig.group` MUST have `id`, `logic` ("AND"/"OR"), and `rules` array
- Each rule MUST have `id`, `operator` (">=", "<=", ">", "<", "==", "!="), `leftOperand`, `rightOperand`
- WRONG: omitting `conditionConfig` -- the UI cannot render the condition without it
- Condition edges MUST use `sourceHandle`: `"true"` for the matching branch, `"false"` for the non-matching branch

**Discord node (required fields: actionType, discordMessage):**
```json
{
  "id": "discord-ok",
  "type": "action",
  "position": {"x": 1150, "y": 150},
  "data": {
    "type": "action",
    "label": "Discord: Rate Healthy",
    "description": "Report healthy rETH exchange rate to Discord",
    "config": {
      "actionType": "discord/send-message",
      "discordMessage": "**Rocket Pool rETH Rate: Healthy**\n\nExchange Rate: {{@fmt:Format Rate.result.formatted}} ETH per rETH\nRaw Value: {{@fmt:Format Rate.result.raw}}\n\nRate is at or above 1.0 ETH."
    },
    "status": "idle"
  }
}
```
- WRONG: `"message": "..."` -- this field is ignored. MUST use `discordMessage`.
- The `integrationId` is optional in seed workflows (user configures it in the UI).

**SendGrid email node (required fields: actionType, emailTo, emailSubject, emailBody):**
```json
{
  "id": "email-report",
  "type": "action",
  "position": {"x": 850, "y": 250},
  "data": {
    "type": "action",
    "label": "Email: Position Report",
    "description": "SendGrid email with staking position summary",
    "config": {
      "actionType": "sendgrid/send-email",
      "emailTo": "treasury@example.com",
      "emailSubject": "Daily Rocket Pool Staking Report",
      "emailBody": "Rocket Pool Report\n\nrETH Balance: {{@calc:Calculate Value.result.balance}} rETH\nETH Value: {{@calc:Calculate Value.result.ethValue}} ETH"
    },
    "status": "idle"
  }
}
```
- WRONG: `"text"`, `"subject"`, `"to"` -- these fields are ignored.
- MUST use exactly: `emailTo`, `emailSubject`, `emailBody`.

**Webhook node (required fields: actionType, webhookUrl, webhookMethod, webhookHeaders, webhookPayload):**
```json
{
  "id": "pagerduty-alert",
  "type": "action",
  "position": {"x": 1150, "y": 400},
  "data": {
    "type": "action",
    "label": "PagerDuty: Rate Depeg Alert",
    "description": "Critical alert -- rETH rate dropped below 1.0 ETH",
    "config": {
      "actionType": "webhook/send-webhook",
      "webhookUrl": "https://events.pagerduty.com/v2/enqueue",
      "webhookMethod": "POST",
      "webhookHeaders": "{\"Content-Type\":\"application/json\"}",
      "webhookPayload": "{\"routing_key\":\"YOUR_PAGERDUTY_ROUTING_KEY\",\"event_action\":\"trigger\",\"payload\":{\"summary\":\"rETH rate below 1.0 ETH\",\"severity\":\"critical\",\"source\":\"keeperhub-{slug}\",\"component\":\"{slug}-workflows\",\"custom_details\":{\"rate\":\"{{@fmt:Format Rate.result.formatted}}\"}}}"
    },
    "status": "idle"
  }
}
```
- WRONG: `"url"`, `"body"`, `"method"`, `"headers"` -- these fields are ignored.
- MUST use exactly: `webhookUrl`, `webhookMethod`, `webhookHeaders`, `webhookPayload`.
- `webhookHeaders` MUST be a JSON string (not an object).
- `webhookPayload` MUST be a JSON string (not an object).

**Edge structures:**

Sequential edge:
```json
{"id": "e1", "source": "trigger-1", "target": "read-rate"}
```

Condition branch edge (MUST include sourceHandle and type):
```json
{"id": "e4", "type": "animated", "source": "cond-peg", "target": "discord-ok", "sourceHandle": "true"}
{"id": "e5", "type": "animated", "source": "cond-peg", "target": "pagerduty-alert", "sourceHandle": "false"}
```
- `sourceHandle: "true"` = condition matched (left/top branch)
- `sourceHandle: "false"` = condition not matched (right/bottom branch)
- `type: "animated"` makes condition branches visually distinct in the UI

What to generate:
- 1 test workflow per read action: manual trigger + single action node, named `[Test - {action-slug}] {description}`
- Up to 8-10 example workflows, as many as the protocol's actions meaningfully support. Protocols with few actions may only warrant 2-3 examples -- do not force artificial workflows. Combine multiple actions with Code formatting nodes and notification actions (Discord, SendGrid, Webhook/PagerDuty). Cover as many action combinations as possible.
- Write actions do NOT get test workflows (they require wallets)
- Example workflows SHOULD include Condition nodes with branching (true/false paths) for monitoring/alerting scenarios
- Example workflows SHOULD use a mix of notification types: Discord for status updates, PagerDuty webhooks for alerts, SendGrid for reports/dashboards

Workflow rules:
- All workflows target only chains with explorer configs (see `<explorer_chain_availability>`)
- All Code nodes MUST use `actionType: "code/run-code"` (see `<code_node_patterns>`)
- All Code nodes follow template quoting rules (no manual quotes around template refs, divide-by-zero guards, Intl formatting)
- All Condition nodes MUST include `conditionConfig` with `group` and `rules` (not just a `condition` string)
- All Schedule triggers MUST use `scheduleCron` and `scheduleTimezone` (not `cron`)
- All Discord nodes MUST use `discordMessage` (not `message`)
- All SendGrid nodes MUST use `emailTo`, `emailSubject`, `emailBody` (not `text`, `subject`, `to`)
- All Webhook nodes MUST use `webhookUrl`, `webhookMethod`, `webhookHeaders`, `webhookPayload` (not `url`, `method`, `headers`, `body`)
- Only use action types that exist in the codebase: `discord/send-message`, `sendgrid/send-email`, `webhook/send-webhook`, `code/run-code`, `Condition`, `{protocol-slug}/{action-slug}`
- Do NOT use non-existent action types like `telegram/send-message`, `slack/send-message`, etc.
- Node labels MUST NOT contain colons -- see `<code_node_patterns>` for details. Use `"Read ETH Price"` not `"Chronicle: Read ETH Price"`.
- Node layout: trigger at x=100, subsequent nodes at x+250 increments, y=250 baseline. For parallel reads, stagger y positions (150, 300, 450).
- Edge naming: sequential e1, e2, etc.
- Generate unique IDs for workflow rows (use a descriptive kebab-case prefix, e.g., `rp-ex-rate-monitor-01`)
</example_workflow_generation>
