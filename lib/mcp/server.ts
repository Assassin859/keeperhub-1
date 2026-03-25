import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDynamicTools, registerTools } from "./tools";

async function fetchJson(
  baseUrl: string,
  authHeader: string,
  path: string
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API call failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  return response.json();
}

function registerResources(
  server: McpServer,
  baseUrl: string,
  authHeader: string
): void {
  server.resource(
    "workflows-list",
    "keeperhub://workflows",
    { description: "List all workflows for the authenticated organization" },
    async (_uri) => {
      const data = await fetchJson(baseUrl, authHeader, "/api/workflows");
      return {
        contents: [
          {
            uri: "keeperhub://workflows",
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  const workflowTemplate = new ResourceTemplate("keeperhub://workflows/{id}", {
    list: undefined,
  });

  server.resource(
    "workflow-by-id",
    workflowTemplate,
    { description: "Get a specific workflow by ID" },
    async (_uri, variables) => {
      const id = variables.id;
      const data = await fetchJson(baseUrl, authHeader, `/api/workflows/${id}`);
      return {
        contents: [
          {
            uri: `keeperhub://workflows/${id}`,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}

export function createMcpServer(
  baseUrl: string,
  authHeader: string,
  scope?: string
): McpServer {
  const server = new McpServer({
    name: "keeperhub",
    version: "1.0.0",
  });

  registerTools(server, baseUrl, authHeader, scope);
  registerDynamicTools(server, baseUrl, authHeader, scope);
  registerResources(server, baseUrl, authHeader);

  return server;
}
