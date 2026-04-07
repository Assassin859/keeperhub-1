import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { BUILTIN_NODE_ID, BUILTIN_NODE_LABEL } from "@/lib/builtin-variables";

import { db } from "@/lib/db";
import { chains, explorerConfigs } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  type ActionConfigFieldBase,
  computeActionId,
  flattenConfigFields,
  getAllIntegrations,
  type IntegrationPlugin,
  type PluginAction,
} from "@/plugins/registry";

// =============================================================================
// SYSTEM ACTIONS (inline - these rarely change)
// To add a new system action: add entry here and implement in lib/steps/
// =============================================================================
const SYSTEM_ACTIONS = {
  Condition: {
    actionType: "Condition",
    label: "Condition",
    description:
      "Conditional branch with dual output paths (true/false). Connect downstream nodes to the 'true' or 'false' source handles to create if/else logic in a single Condition node.",
    category: "System",
    requiredFields: {
      condition:
        'string - JavaScript expression using {{@nodeId:Label.field}} syntax. Supported operators: == (soft equals), === (equals), != (soft not equals), !== (not equals), >, >=, <, <=, contains, startsWith, endsWith, matchesRegex, isEmpty, isNotEmpty, exists, doesNotExist. Use == for cross-type comparisons (e.g., string "0" vs number 0). Example: "{{@check-balance:Check Balance.balance}} == 0"',
    },
    optionalFields: {
      conditionConfig:
        'object - Visual condition builder config. Structure: { group: { id: "nanoid", logic: "AND" | "OR", rules: [{ id: "nanoid", leftOperand: "{{@nodeId:Label.field}}", operator: "===" | "==" | "!==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "startsWith" | "endsWith" | "isEmpty" | "isNotEmpty" | "exists" | "doesNotExist" | "matchesRegex", rightOperand: "value" }] } }. Every group and rule MUST have a unique id. Operator must be the exact symbol (e.g. "===" not "equals", "<" not "less_than"). When provided, the condition expression is auto-generated from this visual config.',
    },
    outputFields: {
      result: "boolean - Whether the condition evaluated to true",
    },
    sourceHandles: ["true", "false"],
    behavior:
      "BRANCH - has two output handles ('true' and 'false'). Edges from sourceHandle 'true' execute when condition is true; edges from sourceHandle 'false' execute when condition is false. For new workflows, always set sourceHandle on edges from Condition nodes.",
  },
  "HTTP Request": {
    actionType: "HTTP Request",
    label: "HTTP Request",
    description: "Make HTTP requests to external APIs",
    category: "System",
    requiredFields: {
      endpoint: "string - Full URL to call",
      httpMethod: "string - GET, POST, PUT, DELETE, or PATCH",
    },
    optionalFields: {
      httpHeaders: "string - JSON object of headers",
      httpBody: "string - JSON request body (ignored for GET)",
    },
    outputFields: {
      status: "number - HTTP status code",
      data: "object - Response body (parsed JSON)",
      headers: "object - Response headers",
    },
  },
  "Database Query": {
    actionType: "Database Query",
    label: "Database Query",
    description: "Execute SQL queries against connected database",
    category: "System",
    requiredFields: {
      integrationId: "string - ID of the database integration",
      dbQuery:
        "string - SQL query with inline template references for dynamic values. Use {{@nodeId:Label.field}} directly in the SQL string. Example: \"INSERT INTO logs (vault, price) VALUES ('{{@compute:Compare.bestVault}}', '{{@compute:Compare.bestPrice}}')\" or \"SELECT * FROM positions WHERE address = '{{@trigger:Trigger.data.address}}'\"",
    },
    optionalFields: {
      dbSchema: "string - JSON schema for result typing",
    },
    outputFields: {
      rows: "array - Query result rows",
      rowCount: "number - Number of rows returned",
    },
  },
  "For Each": {
    actionType: "For Each",
    label: "For Each",
    description:
      "Loop over an array - executes connected body nodes once per element. Optionally pair with a downstream Collect node to aggregate results. Without Collect, the loop runs as fire-and-forget (side effects only).",
    category: "System",
    requiredFields: {
      arraySource:
        'string - Template reference to an array, e.g., "{{@db-query-1:Database Query.rows}}" or "{{@http-1:HTTP Request.data.items}}"',
    },
    optionalFields: {
      maxIterations:
        "number - Safety limit on iterations (default: processes entire array)",
      mapExpression:
        'string - Dot-path to extract from each element, e.g., "address" or "data.name". When set, the iteration output is transformed before being collected.',
      concurrency:
        '"sequential" | "parallel" | "custom" - Execution mode for iterations (default: "sequential"). "parallel" runs all at once, "custom" uses concurrencyLimit.',
      concurrencyLimit:
        'number - Max concurrent iterations when concurrency is "custom" (min: 2)',
    },
    outputFields: {
      currentItem:
        "unknown - Current array element (available inside loop body only via {{@forEachNodeId:For Each.currentItem}})",
      index:
        "number - Current zero-based iteration index (available inside loop body only)",
      totalItems:
        "number - Total number of items being iterated (available inside loop body only)",
    },
    behavior:
      "LOOP - executes all downstream nodes once per array element. Optionally end with a Collect node to aggregate results. Without Collect, all downstream nodes run as fire-and-forget.",
  },
  Collect: {
    actionType: "Collect",
    label: "Collect",
    description:
      "Gathers results from a preceding For Each loop into an array. Place downstream of a For Each node to mark the end of the loop body and enable result aggregation.",
    category: "System",
    requiredFields: {},
    optionalFields: {},
    outputFields: {
      results:
        "array - Array of outputs from each iteration (one entry per element)",
      count: "number - Number of iterations completed",
    },
  },
} as const;

// =============================================================================
// TRIGGERS (inline - these rarely change)
// To add a new trigger: add entry here and implement in trigger-config.tsx
// =============================================================================
const TRIGGERS = {
  Manual: {
    triggerType: "Manual",
    label: "Manual",
    description: "Manually triggered workflow via UI or API",
    requiredFields: {},
    optionalFields: {},
    outputFields: {
      triggeredAt:
        "string - ISO timestamp when the workflow was triggered (available on all trigger types)",
    },
  },
  Schedule: {
    triggerType: "Schedule",
    label: "Schedule",
    description: "Time-based scheduled trigger using cron expressions",
    requiredFields: {
      scheduleCron:
        'string - Cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am)',
    },
    optionalFields: {
      scheduleTimezone: 'string - Timezone (e.g., "America/New_York", "UTC")',
    },
    outputFields: {
      triggeredAt:
        "string - ISO timestamp when the schedule fired (available on all trigger types)",
    },
  },
  Webhook: {
    triggerType: "Webhook",
    label: "Webhook",
    description:
      "HTTP webhook trigger - workflow executes when webhook URL receives a request",
    requiredFields: {},
    optionalFields: {
      webhookSchema: "string - JSON schema for expected payload validation",
      webhookMockRequest: "string - Sample JSON payload for testing",
    },
    outputFields: {
      body: "object - Webhook request body",
      headers: "object - Webhook request headers",
      method: "string - HTTP method (GET, POST, etc.)",
      query: "object - Query parameters",
      triggeredAt:
        "string - ISO timestamp when the webhook was received (available on all trigger types)",
    },
  },
  Event: {
    triggerType: "Event",
    label: "Blockchain Event",
    description:
      "Blockchain event trigger - listens for smart contract events on-chain",
    requiredFields: {
      network:
        'string - Chain ID to listen on (e.g., "1" for Ethereum, "11155111" for Sepolia)',
      contractAddress: "string - Contract address to watch for events",
      contractABI:
        "string - Contract ABI JSON (auto-fetched if contract is verified)",
      eventName:
        'string - Event name to listen for (e.g., "Transfer", "Approval")',
    },
    optionalFields: {},
    outputFields: {
      eventName: "string - Name of the event that was emitted",
      args: "object - Event arguments (decoded parameters from ABI)",
      blockNumber: "number - Block number where event was emitted",
      transactionHash: "string - Transaction hash that emitted the event",
      address: "string - Contract address that emitted the event",
      logIndex: "number - Index of the log in the block",
      triggeredAt:
        "string - ISO timestamp when the event was detected (available on all trigger types)",
    },
  },
  Block: {
    triggerType: "Block",
    label: "Block",
    description:
      "Blockchain block trigger - fires workflow at block intervals on a chain",
    requiredFields: {
      network: 'string - Chain ID (e.g., "1" for Ethereum, "8453" for Base)',
      blockInterval:
        'string - Fire every N blocks (e.g., "1" for every block, "10" for every 10th)',
    },
    optionalFields: {},
    outputFields: {
      blockNumber: "number - The block height",
      blockHash: "string - Hash of the block",
      blockTimestamp: "number - Unix timestamp of the block",
      parentHash: "string - Hash of the parent block",
      triggeredAt:
        "string - ISO timestamp when the block was detected (available on all trigger types)",
    },
  },
} as const;

// =============================================================================
// TEMPLATE SYNTAX DOCUMENTATION (inline - core system behavior)
// Update if template engine syntax changes in lib/steps/step-handler.ts
// =============================================================================
const TEMPLATE_SYNTAX = {
  pattern: "{{@nodeId:Label.field}}",
  description:
    "Reference output from a previous node in the workflow. The @ symbol indicates a node reference.",
  examples: [
    {
      template: "{{@check-balance:Check Balance.balance}}",
      description:
        "Reference the 'balance' output from a node labeled 'Check Balance'",
    },
    {
      template: "{{@trigger:Trigger.body.amount}}",
      description: "Reference nested field 'amount' from webhook trigger body",
    },
    {
      template: "{{@http-1:Fetch Price.data.price}}",
      description: "Reference 'price' from HTTP request response data",
    },
    {
      template: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.unixTimestamp}}`,
      description:
        "Current Unix timestamp in seconds (built-in, evaluated at execution time)",
    },
  ],
  notes: [
    "nodeId is the unique identifier of the node (visible in node settings)",
    "Label is the human-readable name shown on the node",
    "Nested fields use dot notation (e.g., data.nested.value)",
    "Templates are resolved at runtime before each step executes",
  ],
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function mapFieldType(field: ActionConfigFieldBase): string {
  switch (field.type) {
    case "number":
      return "number";
    case "chain-select":
      return "string (chain ID)";
    case "token-select":
      return 'string (JSON) - Token selection config. Use: {"mode":"custom","customToken":{"address":"0x...","symbol":"USDC"}} for a known token address';
    case "abi-function-select":
      return "string (function name from ABI)";
    case "abi-function-args":
      return "string (JSON array of function arguments)";
    case "abi-with-auto-fetch":
      return "string (JSON ABI - auto-fetched for verified contracts)";
    case "abi-event-select":
      return "string (event name from ABI)";
    case "select":
      return `string (${field.options?.map((o) => `"${o.value}"`).join(" | ") || "select"})`;
    case "template-input":
    case "template-textarea":
      return "string (supports {{@nodeId:Label.field}} templates)";
    default:
      return "string";
  }
}

function transformPluginAction(
  plugin: IntegrationPlugin,
  action: PluginAction
): {
  actionType: string;
  label: string;
  description: string;
  category: string;
  integration: string;
  requiresCredentials: boolean;
  requiredFields: Record<string, string>;
  optionalFields: Record<string, string>;
  outputFields: Record<string, string>;
} {
  const actionType = computeActionId(plugin.type, action.slug);
  const flatFields = flattenConfigFields(action.configFields);

  const requiredFields: Record<string, string> = {};
  const optionalFields: Record<string, string> = {};

  for (const field of flatFields) {
    const fieldDesc = `${mapFieldType(field)}${field.placeholder ? ` - ${field.placeholder}` : ""}`;

    if (field.required) {
      requiredFields[field.key] = fieldDesc;
    } else {
      optionalFields[field.key] = fieldDesc;
    }
  }

  const outputFields: Record<string, string> = {};
  if (action.outputFields) {
    for (const output of action.outputFields) {
      outputFields[output.field] = output.description;
    }
  }

  return {
    actionType,
    label: action.label,
    description: action.description,
    category: action.category,
    integration: plugin.type,
    requiresCredentials:
      action.requiresCredentials ?? plugin.requiresCredentials ?? false,
    requiredFields,
    optionalFields,
    outputFields,
  };
}

/**
 * Check if a plugin has ABI auto-fetch field type
 */
function pluginHasAbiAutoFetch(plugin: IntegrationPlugin): boolean {
  for (const action of plugin.actions) {
    const flatFields = flattenConfigFields(action.configFields);
    if (flatFields.some((field) => field.type === "abi-with-auto-fetch")) {
      return true;
    }
  }
  return false;
}

/**
 * Derive platform capabilities from plugin definitions
 */
function derivePlatformCapabilities(plugins: IntegrationPlugin[]) {
  const web3Plugin = plugins.find((p) => p.type === "web3");
  const hasAbiAutoFetch = web3Plugin
    ? pluginHasAbiAutoFetch(web3Plugin)
    : false;

  return {
    wallet: web3Plugin
      ? {
          provider: "Para",
          features: ["mpc", "non-custodial", "hosted"],
          description:
            "Para MPC wallet - keys are split between user and Para, neither party can sign alone",
        }
      : null,
    proxyContracts: hasAbiAutoFetch
      ? {
          supported: true,
          autoDetectImplementation: true,
          supportedPatterns: ["EIP-1967", "EIP-1822", "Diamond (EIP-2535)"],
          description:
            "Proxy contracts are automatically detected and implementation ABIs fetched",
        }
      : { supported: false },
    abiHandling: hasAbiAutoFetch
      ? {
          autoFetchVerified: true,
          manualAbiSupported: true,
          description:
            "ABIs auto-fetched from block explorers for verified contracts. Manual ABI input available for unverified contracts.",
        }
      : null,
  };
}

// =============================================================================
// API ENDPOINT
// =============================================================================

type ChainInfo = {
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  isTestnet: boolean;
  explorerUrl: string | null;
};

/**
 * GET /api/mcp/schemas
 *
 * Returns all workflow schemas for the MCP server.
 * This is the source of truth that the KeeperHub MCP fetches from.
 *
 * Query params:
 * - category: Filter to a specific category (e.g., "web3", "system", "discord")
 * - includeChains: "true" to include supported chains (default: true)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const categoryFilter = searchParams.get("category")?.toLowerCase();
  const includeChains = searchParams.get("includeChains") !== "false";

  // Get all plugins from registry
  const allPlugins = getAllIntegrations();

  // Transform plugin actions
  const pluginActions: Record<
    string,
    ReturnType<typeof transformPluginAction>
  > = {};
  for (const plugin of allPlugins) {
    if (categoryFilter && plugin.type !== categoryFilter) {
      continue;
    }
    for (const action of plugin.actions) {
      const transformed = transformPluginAction(plugin, action);
      pluginActions[transformed.actionType] = transformed;
    }
  }

  // Filter system actions if category specified
  const systemActions =
    !categoryFilter || categoryFilter === "system" ? SYSTEM_ACTIONS : {};

  // Filter triggers if category specified
  const triggers =
    !categoryFilter || categoryFilter === "triggers" ? TRIGGERS : {};

  // Fetch chains from database
  let chainList: ChainInfo[] = [];
  if (includeChains) {
    try {
      const results = await db
        .select({
          chain: chains,
          explorer: explorerConfigs,
        })
        .from(chains)
        .leftJoin(explorerConfigs, eq(chains.chainId, explorerConfigs.chainId))
        .where(eq(chains.isEnabled, true));

      chainList = results.map(({ chain, explorer }) => ({
        chainId: chain.chainId,
        name: chain.name,
        symbol: chain.symbol,
        chainType: chain.chainType,
        isTestnet: chain.isTestnet ?? false,
        explorerUrl: explorer?.explorerUrl ?? null,
      }));
    } catch (error) {
      logSystemError(
        ErrorCategory.DATABASE,
        "[MCP Schemas] Failed to fetch chains",
        error,
        { endpoint: "/api/mcp/schemas", operation: "get" }
      );
      // Continue without chains rather than failing the whole request
    }
  }

  // Derive platform capabilities from plugins
  const platformCapabilities = derivePlatformCapabilities(allPlugins);

  const response = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),

    // All available actions (plugins + system)
    actions: {
      ...pluginActions,
      ...systemActions,
    },

    // All available triggers
    triggers,

    // Supported blockchain networks (from database)
    chains: chainList,

    // Platform capabilities (derived from plugins)
    platform: platformCapabilities,

    // Template syntax documentation
    templateSyntax: TEMPLATE_SYNTAX,

    // Built-in system variables (evaluated at runtime)
    builtinVariables: {
      description: `Built-in variables evaluated at runtime. Reference using {{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.fieldName}} syntax.`,
      nodeId: BUILTIN_NODE_ID,
      nodeLabel: BUILTIN_NODE_LABEL,
      variables: {
        unixTimestamp: {
          type: "number",
          description:
            "Current Unix timestamp in seconds (Solidity-compatible, matches block.timestamp)",
          example: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.unixTimestamp}}`,
        },
        unixTimestampMs: {
          type: "number",
          description:
            "Current Unix timestamp in milliseconds (JavaScript Date.now())",
          example: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.unixTimestampMs}}`,
        },
        isoTimestamp: {
          type: "string",
          description: "Current time as ISO 8601 UTC string",
          example: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.isoTimestamp}}`,
        },
      },
    },

    // Workflow structure hints for AI
    workflowStructure: {
      nodeStructure: {
        id: "string - Unique node identifier",
        type: '"trigger" | "action"',
        position:
          "{ x: number, y: number } - Optional, auto-laid out if omitted",
        data: {
          label: "string - Human-readable node name",
          description: "string - Optional description",
          type: '"trigger" | "action"',
          config: "object - Action/trigger specific configuration",
          status: '"idle" | "running" | "success" | "error"',
        },
      },
      edgeStructure: {
        id: "string - Unique edge identifier",
        source: "string - Source node ID",
        target: "string - Target node ID",
        sourceHandle:
          "string (optional) - For Condition node edges: 'true' or 'false'. For For Each node edges: 'loop' or 'done'. Omit for all other node types.",
        note: "Do NOT use targetHandle. sourceHandle is only needed for Condition and For Each node edges.",
      },
    },

    // Projects - workflow grouping
    projects: {
      description:
        "Workflows can be organized into projects. Use projectId when creating or updating workflows to assign them to a project.",
      endpoints: {
        list: "GET /api/projects - List all projects for the org (includes workflowCount)",
        create:
          "POST /api/projects - Create project with { name, description?, color? }",
        update:
          "PATCH /api/projects/:id - Update project name/description/color",
        delete:
          "DELETE /api/projects/:id - Delete project (workflows become uncategorized)",
      },
      workflowFields: {
        projectId:
          "string | null - Optional project ID to assign the workflow to. Pass null to unassign.",
      },
    },

    // Tags - workflow labeling
    tags: {
      description:
        "Workflows can be labeled with a single tag per workflow. Tags are organization-scoped and have a name and color. Use tagId when creating or updating workflows to assign a tag.",
      endpoints: {
        list: "GET /api/tags - List all tags for the org (includes workflowCount)",
        create:
          "POST /api/tags - Create tag with { name, color } (color is required, e.g. '#4A90D9')",
        update: "PATCH /api/tags/:id - Update tag name/color",
        delete:
          "DELETE /api/tags/:id - Delete tag (workflows lose their tag assignment)",
      },
      workflowFields: {
        tagId:
          "string | null - Optional tag ID to assign to the workflow. Pass null to unassign. Each workflow can have at most one tag.",
      },
    },

    // Tips for AI workflow generation
    tips: [
      "actionType must match exactly (e.g., 'web3/check-balance', not 'Get Wallet Balance')",
      "Use {{@nodeId:Label.field}} syntax to reference outputs from previous nodes",
      "network should be chain ID as string (e.g., '1' for mainnet, '11155111' for sepolia)",
      "Edges need id, source, and target. For Condition nodes, also set sourceHandle to 'true' or 'false' to control which branch executes.",
      "For verified contracts, ABI is auto-fetched. For unverified contracts, provide ABI manually.",
      "Condition nodes have dual output handles ('true' and 'false'). Set sourceHandle on edges to route execution. For if/else, connect different nodes to each handle of a single Condition node.",
      "integrationId is required for actions that need credentials (discord, sendgrid, database)",
      "web3 read actions (check-balance, read-contract) don't require wallet integration",
      "web3 write actions (transfer-funds, write-contract) require wallet integration",
      "web3/query-transactions queries historical transactions by function call using block explorer APIs. Use it when the contract does not emit events for the operations you need to monitor. Provide functionArgs as a JSON array where empty strings are wildcards.",
      'tokenConfig must be a JSON string with format: {"mode":"custom","customToken":{"address":"0x...","symbol":"USDC"}} -- do NOT use a flat {address, symbol, decimals} object',
      "Use projectId to organize related workflows into a project (e.g., all Sky ESM workflows in one project)",
      "Use tagId to label a workflow with a single tag (e.g., 'production', 'monitoring'). Each workflow supports one tag. Fetch available tags from GET /api/tags first.",
      `Use {{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.unixTimestamp}} for current time comparisons in conditions (e.g., checking if a contract timestamp has passed)`,
      "All trigger types expose a 'triggeredAt' output field (ISO timestamp). Reference it with {{@triggerId:TriggerLabel.data.triggeredAt}} to include when the workflow fired.",
      "Database Query: use inline {{@nodeId:Label.field}} template refs directly in the SQL string. Do NOT use parameterized $1/$2 placeholders with a separate dbParams array. The UI does not support that format.",
      "Condition conditionConfig: every group and rule MUST have a unique 'id' field (use nanoid or UUID). Operators must be exact symbols: '===' not 'equals', '<' not 'less_than', '>' not 'greater_than'. Rule fields are 'leftOperand' and 'rightOperand', NOT 'field' and 'value'.",
    ],
  };

  return NextResponse.json(response, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
