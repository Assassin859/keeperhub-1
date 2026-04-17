import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getProtocol } from "@/lib/protocol-registry";
import { db } from "@/lib/db";
import { type Chain, chains, workflows } from "@/lib/db/schema";
import type { WorkflowNode } from "@/lib/workflow-store";
import { WorkflowTriggerEnum } from "@/lib/workflow-store";

/**
 * Internal endpoint for workers to fetch active Event-type workflows
 * Returns only enabled workflows with Event trigger type
 * Requires X-Internal-Token header for authentication
 */
export async function GET(request: Request) {
  try {
    // Check for internal token authentication
    const internalToken = request.headers.get("X-Internal-Token");
    const expectedToken = process.env.EVENTS_SERVICE_API_KEY;

    if (!expectedToken) {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Workflows Events] EVENTS_SERVICE_API_KEY not configured",
        new Error(
          "EVENTS_SERVICE_API_KEY environment variable is not configured"
        ),
        {
          endpoint: "/api/workflows/events",
          component: "events-service",
        }
      );
      return NextResponse.json(
        { error: "Internal endpoint not configured" },
        { status: 500 }
      );
    }

    if (!internalToken || internalToken !== expectedToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const activeParam = searchParams.get("active");

    const filterActive = activeParam === "true";

    const query = db
      .select({
        id: workflows.id,
        name: workflows.name,
        userId: workflows.userId,
        organizationId: workflows.organizationId,
        enabled: workflows.enabled,
        nodes: workflows.nodes,
      })
      .from(workflows);

    const allWorkflows = filterActive
      ? await query.where(eq(workflows.enabled, true))
      : await query;

    const eventWorkflows = allWorkflows
      .map((workflow) => {
        try {
          const nodes = workflow.nodes as WorkflowNode[];
          if (!Array.isArray(nodes)) {
            return null;
          }

          const triggerNode = nodes.find(
            (node) => node.data?.type === "trigger"
          );

          if (!triggerNode) {
            return null;
          }

          // Check if trigger type is Event
          const triggerType = triggerNode.data?.config?.triggerType as
            | string
            | undefined;

          if (triggerType !== WorkflowTriggerEnum.EVENT) {
            return null;
          }

          // Try to infer contract address from protocol and event slug
          const config = triggerNode.data?.config;
          if (config && !config.contractAddress) {
            const protocolSlug = config._eventProtocolSlug as
              | string
              | undefined;
            const eventSlug = config._eventSlug as string | undefined;
            const network = config.network as string | undefined;

            if (protocolSlug && eventSlug && network) {
              const protocol = getProtocol(protocolSlug);
              const event = protocol?.events?.find(
                (e) => e.slug === eventSlug
              );
              if (protocol && event) {
                const contract = protocol.contracts[event.contract];
                const address = contract?.addresses[network];
                if (address) {
                  config.contractAddress = address;
                }
              }
            }
          }

          return {
            id: workflow.id,
            name: workflow.name,
            userId: workflow.userId,
            organizationId: workflow.organizationId,
            enabled: workflow.enabled,
            nodes: [triggerNode],
          };
        } catch {
          // If parsing fails, exclude this workflow
          return null;
        }
      })
      .filter((workflow) => workflow !== null);

    const networks = await db
      .select({
        id: chains.id,
        chainId: chains.chainId,
        name: chains.name,
        symbol: chains.symbol,
        chainType: chains.chainType,
        defaultPrimaryRpc: chains.defaultPrimaryRpc,
        defaultFallbackRpc: chains.defaultFallbackRpc,
        defaultPrimaryWss: chains.defaultPrimaryWss,
        defaultFallbackWss: chains.defaultFallbackWss,
        usePrivateMempoolRpc: chains.usePrivateMempoolRpc,
        defaultPrivateRpcUrl: chains.defaultPrivateRpcUrl,
        isTestnet: chains.isTestnet,
        isEnabled: chains.isEnabled,
        createdAt: chains.createdAt,
        updatedAt: chains.updatedAt,
        gasConfig: chains.gasConfig,
      })
      .from(chains);

    // Return a dictionary of chains by chainId to make it easier to lookup
    const networkMap: Record<number, Chain> = {};

    for (const network of networks) {
      networkMap[network.chainId] = network;
    }

    const response = {
      workflows: eventWorkflows,
      networks: networkMap,
    };

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get event workflows", error, { endpoint: "/api/workflows/events", operation: "get" });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get event workflows",
      },
      { status: 500 }
    );
  }
}

