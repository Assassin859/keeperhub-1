import { NextResponse } from "next/server";
import {
  createIntegration,
  ensureWalletIntegration,
  getIntegrations,
} from "@/lib/db/integrations";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@/lib/types/integration";

export type GetIntegrationsResponse = {
  id: string;
  name: string;
  type: IntegrationType;
  isManaged?: boolean;
  createdAt: string;
  updatedAt: string;
  // Config is intentionally excluded for security
}[];

export type CreateIntegrationRequest = {
  name?: string;
  type: IntegrationType;
  config: IntegrationConfig;
};

export type CreateIntegrationResponse = {
  id: string;
  name: string;
  type: IntegrationType;
  createdAt: string;
  updatedAt: string;
};

/**
 * GET /api/integrations
 * List all integrations for the authenticated user
 */
export async function GET(request: Request) {
  try {
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId } = authContext;

    if (!(userId || organizationId)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get optional type filter from query params
    const { searchParams } = new URL(request.url);
    const typeFilter = searchParams.get("type") as IntegrationType | null;

    // Repair wallet/integration data drift before listing: orgs whose
    // wallet pre-dates the auto-create code (or whose web3 integration
    // row was deleted) would otherwise see "Add Web3 connection" in the
    // workflow builder despite having a working wallet. This makes the
    // first read after deploy heal silently and is a no-op for everyone
    // already in the consistent state.
    if (userId && organizationId) {
      try {
        await ensureWalletIntegration(userId, organizationId);
      } catch (error) {
        // Non-fatal: log and continue. Worst case is the user briefly
        // sees the orange warning until the next read; the wallet
        // itself still works.
        logSystemError(
          ErrorCategory.DATABASE,
          "[Integrations] Failed to ensure wallet integration",
          error,
          {
            endpoint: "/api/integrations",
            operation: "ensureWalletIntegration",
          }
        );
      }
    }

    const integrations = await getIntegrations(
      userId ?? "",
      typeFilter || undefined,
      organizationId
    );

    // Return integrations without config for security
    const response: GetIntegrationsResponse = integrations.map(
      (integration) => ({
        id: integration.id,
        name: integration.name,
        type: integration.type,
        isManaged: integration.isManaged ?? false,
        createdAt: integration.createdAt.toISOString(),
        updatedAt: integration.updatedAt.toISOString(),
      })
    );

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to get integrations",
      error,
      {
        endpoint: "/api/integrations",
        operation: "get",
      }
    );
    return NextResponse.json(
      {
        error: "Failed to get integrations",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/integrations
 * Create a new integration
 */
export async function POST(request: Request) {
  try {
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    if (!authContext.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId, organizationId } = authContext;

    const body: CreateIntegrationRequest = await request.json();

    if (!(body.type && body.config)) {
      return NextResponse.json(
        { error: "Type and config are required" },
        { status: 400 }
      );
    }

    const integration = await createIntegration({
      userId,
      name: body.name || "",
      type: body.type,
      config: body.config,
      organizationId,
    });

    const response: CreateIntegrationResponse = {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    // KEEP-384: idx_integrations_org_web3 enforces at most one web3
    // integration per org. Surface that as a 409 with a meaningful
    // message instead of letting it fall through to a generic 500.
    if (isWeb3UniqueViolation(error)) {
      return NextResponse.json(
        {
          error:
            "This organization already has a web3 integration for the KeeperHub wallet.",
        },
        { status: 409 }
      );
    }
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to create integration",
      error,
      {
        endpoint: "/api/integrations",
        operation: "create",
      }
    );
    return NextResponse.json(
      {
        error: "Failed to create integration",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

function isWeb3UniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === "23505";
}
