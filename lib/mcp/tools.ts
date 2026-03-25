import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { flattenConfigFields, getAllIntegrations } from "@/plugins/registry";
import { withToolLogging } from "./logging";
import { isToolAllowed } from "./oauth-scopes";

const SCOPE_DENIED_RESULT = {
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: "Forbidden",
        message: "This tool is not allowed by the current OAuth scope.",
      }),
    },
  ],
} as const;

// biome-ignore lint/suspicious/noExplicitAny: SDK ToolCallback uses complex generic overloads that cannot be expressed without any
type AnyToolHandler = (...args: any[]) => unknown;

function withScopeCheck<H extends AnyToolHandler>(
  toolName: string,
  scope: string | undefined,
  handler: H
): H {
  if (scope === undefined) {
    return handler;
  }
  const wrapped = (
    ...args: Parameters<H>
  ): ReturnType<H> | typeof SCOPE_DENIED_RESULT => {
    if (!isToolAllowed(toolName, scope)) {
      return SCOPE_DENIED_RESULT;
    }
    return handler(...args) as ReturnType<H>;
  };
  return wrapped as unknown as H;
}

type ApiResponse = Record<string, unknown>;

async function callApi(
  baseUrl: string,
  authHeader: string,
  path: string,
  method: string,
  body?: unknown,
  organizationId?: string
): Promise<ApiResponse> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
  };

  if (organizationId) {
    headers["X-Organization-Id"] = organizationId;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API call failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as ApiResponse;
  }

  return { result: await response.text() };
}

export function registerTools(
  server: McpServer,
  baseUrl: string,
  authHeader: string,
  scope?: string
): void {
  // =========================================================================
  // Workflow CRUD
  // =========================================================================

  server.tool(
    "list_workflows",
    "List all workflows for the authenticated organization. Optionally filter by projectId or tagId.",
    {
      projectId: z
        .string()
        .optional()
        .describe("Optional project ID to filter workflows"),
      tagId: z
        .string()
        .optional()
        .describe("Optional tag ID to filter workflows"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Optional organization ID to override the API key's default org. The API key creator must be a member of the target org."
        ),
    },
    withScopeCheck("list_workflows", scope, async (args) =>
      withToolLogging("list_workflows", args.organizationId, async () => {
        const params = new URLSearchParams();
        if (args.projectId) {
          params.set("projectId", args.projectId);
        }
        if (args.tagId) {
          params.set("tagId", args.tagId);
        }
        const query = params.toString();
        const path = `/api/workflows${query ? `?${query}` : ""}`;
        const data = await callApi(
          baseUrl,
          authHeader,
          path,
          "GET",
          undefined,
          args.organizationId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_workflow",
    "Get a single workflow by ID, including its nodes, edges, and configuration.",
    {
      workflowId: z.string().describe("The workflow ID"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Optional organization ID to override the API key's default org."
        ),
    },
    withScopeCheck("get_workflow", scope, async (args) =>
      withToolLogging("get_workflow", args.organizationId, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${args.workflowId}`,
          "GET",
          undefined,
          args.organizationId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "create_workflow",
    "Create a new workflow with nodes and edges. Nodes define the trigger and actions; edges define the execution flow.",
    {
      name: z.string().describe("Workflow name"),
      description: z
        .string()
        .optional()
        .describe("Optional workflow description"),
      nodes: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Workflow nodes (trigger + action nodes)"),
      edges: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Workflow edges connecting nodes"),
      projectId: z
        .string()
        .optional()
        .describe("Optional project ID to assign the workflow to"),
      tagId: z
        .string()
        .optional()
        .describe("Optional tag ID to label the workflow"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Optional organization ID to override the API key's default org."
        ),
    },
    withScopeCheck("create_workflow", scope, async (args) =>
      withToolLogging("create_workflow", args.organizationId, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/workflows",
          "POST",
          {
            name: args.name,
            description: args.description,
            nodes: args.nodes,
            edges: args.edges,
            projectId: args.projectId,
            tagId: args.tagId,
          },
          args.organizationId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "update_workflow",
    "Update an existing workflow's name, description, nodes, edges, or project/tag assignment.",
    {
      workflowId: z.string().describe("The workflow ID to update"),
      name: z.string().optional().describe("New workflow name"),
      description: z.string().optional().describe("New workflow description"),
      nodes: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Updated workflow nodes"),
      edges: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Updated workflow edges"),
      projectId: z
        .string()
        .nullable()
        .optional()
        .describe("Project ID to assign (null to unassign)"),
      tagId: z
        .string()
        .nullable()
        .optional()
        .describe("Tag ID to assign (null to unassign)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Optional organization ID to override the API key's default org."
        ),
    },
    withScopeCheck("update_workflow", scope, async (args) =>
      withToolLogging("update_workflow", args.organizationId, async () => {
        const { workflowId, organizationId, ...body } = args;
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${workflowId}`,
          "PUT",
          body,
          organizationId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "delete_workflow",
    "Delete a workflow by ID. This action is irreversible.",
    {
      workflowId: z.string().describe("The workflow ID to delete"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Optional organization ID to override the API key's default org."
        ),
    },
    withScopeCheck("delete_workflow", scope, async (args) =>
      withToolLogging("delete_workflow", args.organizationId, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${args.workflowId}`,
          "DELETE",
          undefined,
          args.organizationId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Execution
  // =========================================================================

  server.tool(
    "execute_workflow",
    "Trigger a manual execution of a workflow. Returns the execution ID for status polling.",
    {
      workflowId: z.string().describe("The workflow ID to execute"),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional input data to pass to the workflow trigger"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Optional organization ID to override the API key's default org. Use this to execute workflows under a different org's context (wallet, settings)."
        ),
    },
    withScopeCheck("execute_workflow", scope, async (args) =>
      withToolLogging("execute_workflow", args.organizationId, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflow/${args.workflowId}/execute`,
          "POST",
          { input: args.input ?? {} },
          args.organizationId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_execution_status",
    "Get the current status of a workflow execution by execution ID.",
    {
      executionId: z
        .string()
        .describe("The execution ID returned by execute_workflow"),
    },
    withScopeCheck("get_execution_status", scope, async (args) =>
      withToolLogging("get_execution_status", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/executions/${args.executionId}/status`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_execution_logs",
    "Get detailed step-by-step logs for a workflow execution.",
    {
      executionId: z.string().describe("The execution ID to fetch logs for"),
    },
    withScopeCheck("get_execution_logs", scope, async (args) =>
      withToolLogging("get_execution_logs", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/executions/${args.executionId}/logs`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // AI Workflow Generation
  // =========================================================================

  server.tool(
    "ai_generate_workflow",
    "Generate a complete workflow from a natural language description using AI. Returns a workflow definition ready to be created.",
    {
      prompt: z
        .string()
        .describe(
          "Natural language description of the workflow to generate, e.g. 'Monitor USDC transfers over $10k and send a Discord alert'"
        ),
      context: z
        .string()
        .optional()
        .describe("Additional context or constraints for the AI generator"),
    },
    withScopeCheck("ai_generate_workflow", scope, async (args) =>
      withToolLogging("ai_generate_workflow", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/ai/generate",
          "POST",
          { prompt: args.prompt, context: args.context }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Discovery
  // =========================================================================

  server.tool(
    "list_action_schemas",
    "List all available action schemas, triggers, and supported chains. Use this to discover what actions and integrations are available for workflow creation.",
    {
      category: z
        .string()
        .optional()
        .describe(
          "Filter by category (e.g., 'web3', 'discord', 'system', 'triggers')"
        ),
      includeChains: z
        .boolean()
        .optional()
        .describe(
          "Whether to include supported blockchain networks (default: true)"
        ),
    },
    withScopeCheck("list_action_schemas", scope, async (args) =>
      withToolLogging("list_action_schemas", undefined, async () => {
        const params = new URLSearchParams();
        if (args.category) {
          params.set("category", args.category);
        }
        if (args.includeChains === false) {
          params.set("includeChains", "false");
        }
        const query = params.toString();
        const path = `/api/mcp/schemas${query ? `?${query}` : ""}`;
        const data = await callApi(baseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "search_plugins",
    "List available action schemas filtered by category (e.g., 'web3', 'discord', 'system').",
    {
      category: z
        .string()
        .describe(
          "Category to filter by (e.g., 'web3', 'discord', 'sendgrid', 'system', 'triggers')"
        ),
    },
    withScopeCheck("search_plugins", scope, async (args) =>
      withToolLogging("search_plugins", undefined, async () => {
        const params = new URLSearchParams({ category: args.category });
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/mcp/schemas?${params.toString()}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_plugin",
    "Get schema details for a specific plugin or integration type.",
    {
      pluginType: z
        .string()
        .describe(
          "Plugin type identifier (e.g., 'web3', 'discord', 'sendgrid')"
        ),
    },
    withScopeCheck("get_plugin", scope, async (args) =>
      withToolLogging("get_plugin", undefined, async () => {
        const params = new URLSearchParams({ category: args.pluginType });
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/mcp/schemas?${params.toString()}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "list_integrations",
    "List all configured integrations (credentials) for the organization. These are required for actions like Discord notifications or Sendgrid emails.",
    {
      organizationId: z
        .string()
        .optional()
        .describe(
          "Optional organization ID to override the API key's default org."
        ),
    },
    withScopeCheck("list_integrations", scope, async (args) =>
      withToolLogging("list_integrations", args.organizationId, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/integrations",
          "GET",
          undefined,
          args.organizationId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_wallet_integration",
    "Get details for a specific wallet integration. Required for web3 write actions like fund transfers and contract writes.",
    {
      integrationId: z.string().describe("The integration (wallet) ID"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Optional organization ID to override the API key's default org."
        ),
    },
    withScopeCheck("get_wallet_integration", scope, async (args) =>
      withToolLogging(
        "get_wallet_integration",
        args.organizationId,
        async () => {
          const data = await callApi(
            baseUrl,
            authHeader,
            `/api/integrations/${args.integrationId}`,
            "GET",
            undefined,
            args.organizationId
          );
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        }
      )
    )
  );

  // =========================================================================
  // Templates
  // =========================================================================

  server.tool(
    "search_templates",
    "Search for pre-built workflow templates that can be deployed and customized.",
    {
      query: z
        .string()
        .optional()
        .describe("Search query to find relevant templates"),
      category: z.string().optional().describe("Filter templates by category"),
    },
    withScopeCheck("search_templates", scope, async (args) =>
      withToolLogging("search_templates", undefined, async () => {
        const params = new URLSearchParams();
        if (args.query) {
          params.set("q", args.query);
        }
        if (args.category) {
          params.set("category", args.category);
        }
        const query = params.toString();
        const path = `/api/workflows/public${query ? `?${query}` : ""}`;
        const data = await callApi(baseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_template",
    "Get details of a specific workflow template by ID.",
    {
      templateId: z.string().describe("The template workflow ID"),
    },
    withScopeCheck("get_template", scope, async (args) =>
      withToolLogging("get_template", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${args.templateId}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "deploy_template",
    "Clone a public template workflow into the organization as a new workflow.",
    {
      templateId: z.string().describe("The template workflow ID to clone"),
      name: z
        .string()
        .optional()
        .describe("Optional name for the cloned workflow"),
    },
    withScopeCheck("deploy_template", scope, async (args) =>
      withToolLogging("deploy_template", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${args.templateId}/duplicate`,
          "POST",
          { name: args.name }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Meta
  // =========================================================================

  server.tool(
    "tools_documentation",
    "Get documentation on how to use the KeeperHub MCP tools, including examples and best practices for workflow creation.",
    {},
    withScopeCheck("tools_documentation", scope, (_args) =>
      withToolLogging("tools_documentation", undefined, () => {
        const text = [
          "KeeperHub MCP Tools Documentation",
          "",
          "WORKFLOW CREATION",
          "1. Call list_action_schemas to discover available actions and triggers",
          "2. Call ai_generate_workflow with a natural language prompt to generate a workflow",
          "3. Call create_workflow with the generated definition to persist it",
          "4. Call execute_workflow to run it manually",
          "5. Call get_execution_status to poll for completion",
          "",
          "WORKFLOW MANAGEMENT",
          "- list_workflows: List all org workflows (filter by projectId or tagId)",
          "- get_workflow: Fetch a single workflow by ID",
          "- update_workflow: Modify name, nodes, edges, project, or tag",
          "- delete_workflow: Permanently delete a workflow",
          "",
          "INTEGRATIONS",
          "- list_integrations: See all configured credentials (Discord, Sendgrid, wallets)",
          "- get_wallet_integration: Get a specific wallet credential (needed for web3 writes)",
          "",
          "TEMPLATES",
          "- search_templates: Browse public workflow templates",
          "- get_template: Inspect a template's structure",
          "- deploy_template: Clone a template into your org",
          "",
          "TEMPLATE SYNTAX",
          "Reference outputs from previous nodes using: {{@nodeId:Label.field}}",
          "Example: {{@check-balance:Check Balance.balance}}",
          "",
          "CHAIN IDs",
          "- Ethereum Mainnet: 1",
          "- Base: 8453",
          "- Sepolia Testnet: 11155111",
          "- Use list_action_schemas (with includeChains: true) for the full list",
        ].join("\n");

        return {
          content: [{ type: "text", text }],
        };
      })
    )
  );
}

// =============================================================================
// Dynamic tool registration from plugin registry
// =============================================================================

function slugToToolName(integration: string, slug: string): string {
  const combined = `${integration}_${slug}`;
  return combined.replace(/[\s/-]/g, "_");
}

export function registerDynamicTools(
  server: McpServer,
  baseUrl: string,
  authHeader: string,
  scope?: string
): void {
  const plugins = getAllIntegrations();

  for (const plugin of plugins) {
    for (const action of plugin.actions) {
      const toolName = slugToToolName(plugin.type, action.slug);
      const flatFields = flattenConfigFields(action.configFields);

      const inputSchema: Record<string, z.ZodTypeAny> = {
        organizationId: z
          .string()
          .optional()
          .describe(
            "Optional organization ID to override the API key's default org."
          ),
      };

      for (const field of flatFields) {
        const fieldSchema = field.required
          ? z.string().describe(field.label)
          : z.string().optional().describe(field.label);
        inputSchema[field.key] = fieldSchema;
      }

      const integration = plugin.type;
      const slug = action.slug;
      const description = action.description;

      server.tool(
        toolName,
        description,
        inputSchema,
        withScopeCheck(toolName, scope, async (args) => {
          const { organizationId, ...fieldArgs } = args as Record<
            string,
            string | undefined
          >;
          return await withToolLogging(toolName, organizationId, async () => {
            const data = await callApi(
              baseUrl,
              authHeader,
              `/api/execute/${integration}/${slug}`,
              "POST",
              fieldArgs,
              organizationId
            );
            return {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
          });
        })
      );
    }
  }
}
