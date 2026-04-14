import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { sanitizeDescription } from "@/lib/sanitize-description";

export const dynamic = "force-dynamic";

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

const DISCOVERY_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  listedSlug: workflows.listedSlug,
  inputSchema: workflows.inputSchema,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  workflowType: workflows.workflowType,
  category: workflows.category,
  chain: workflows.chain,
} as const;

type DiscoveryWorkflow = {
  id: string;
  name: string;
  description: string | null;
  listedSlug: string | null;
  inputSchema: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  workflowType: "read" | "write";
  category: string | null;
  chain: string | null;
};

function buildPathEntry(workflow: DiscoveryWorkflow): Record<string, unknown> {
  const isPaid =
    workflow.workflowType === "read" &&
    Number(workflow.priceUsdcPerCall ?? "0") > 0;
  const isWrite = workflow.workflowType === "write";

  const operation: Record<string, unknown> = {
    operationId: `call-${workflow.listedSlug}`,
    summary: workflow.name,
    description: workflow.description
      ? sanitizeDescription(workflow.description)
      : undefined,
  };

  if (isWrite) {
    operation["x-workflow-type"] = "write";
  }

  if (isPaid) {
    operation["x-payment-info"] = {
      price: {
        mode: "fixed",
        amount: workflow.priceUsdcPerCall,
        currency: "USD",
      },
      protocols: [
        { x402: { network: "eip155:8453" } },
        { mpp: { method: "tempo", intent: "charge", currency: "USDC" } },
      ],
    };
  }

  if (workflow.inputSchema && "properties" in workflow.inputSchema) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": { schema: workflow.inputSchema },
      },
    };
  }

  const responses: Record<string, unknown> = {};

  if (isWrite) {
    responses["200"] = {
      description: "Unsigned transaction calldata",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              type: { type: "string", const: "calldata" },
              to: { type: "string" },
              data: { type: "string" },
              value: { type: "string" },
            },
          },
        },
      },
    };
  } else {
    responses["200"] = {
      description: "Workflow execution started",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              executionId: { type: "string" },
              status: { type: "string", const: "running" },
            },
          },
        },
      },
    };
  }

  if (isPaid) {
    responses["402"] = { description: "Payment Required" };
  }

  operation.responses = responses;

  return { post: operation };
}

export async function GET(request: Request): Promise<Response> {
  const baseUrl = deriveBaseUrl(request);

  const rows = await db
    .select(DISCOVERY_COLUMNS)
    .from(workflows)
    .where(eq(workflows.isListed, true));

  const paths: Record<string, Record<string, unknown>> = {};

  for (const row of rows as DiscoveryWorkflow[]) {
    if (!row.listedSlug) {
      continue;
    }
    paths[`/api/mcp/workflows/${row.listedSlug}/call`] = buildPathEntry(row);
  }

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "KeeperHub",
      version: "1.0.0",
      description:
        "Web3 workflow automation platform. Workflows are callable by AI agents via REST or MCP.",
      "x-guidance":
        "KeeperHub exposes workflows as REST endpoints. Each workflow has a slug and accepts JSON input. Paid workflows require x402 or MPP payment. Free workflows can be called directly. Use GET /api/mcp/workflows to discover available workflows and their pricing.",
    },
    "x-service-info": {
      categories: ["web3", "automation", "blockchain"],
      docs: { homepage: "https://docs.keeperhub.com" },
    },
    servers: [{ url: baseUrl }],
    paths,
  };

  return Response.json(doc, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
