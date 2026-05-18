import { NextResponse } from "next/server";
import {
  createIntegration,
  ensureWalletIntegration,
  getIntegrations,
} from "@/lib/db/integrations";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
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
  /**
   * Canonical EIP-55 wallet address for web3 integrations, or null for
   * other integration types. API consumers MUST prefer this field over
   * `name` when the value is destined for an on-chain call such as
   * `onBehalfOf` (KEEP-484).
   */
  address: string | null;
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
      return apiError({
        status: authContext.status,
        code: ApiErrorCodes.UNAUTHORIZED,
        detail: authContext.error,
        hint: "Provide a valid `Authorization: Bearer <token>` header. API keys start with `kh_`; OAuth tokens are issued via /oauth/authorize.",
        requestHeaders: request.headers,
      });
    }

    const { userId, organizationId } = authContext;

    if (!(userId || organizationId)) {
      return apiError({
        status: 401,
        code: ApiErrorCodes.UNAUTHORIZED,
        detail: "Request has neither a user nor an organization context",
        hint: "Sign in or supply a valid API key.",
        requestHeaders: request.headers,
      });
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
        address: integration.address,
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
    return apiError({
      status: 500,
      code: ApiErrorCodes.INTERNAL_ERROR,
      detail: "Failed to list integrations",
      hint: "Retry with backoff. If the error persists, check the request_id in server logs.",
      requestHeaders: request.headers,
    });
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
      return apiError({
        status: authContext.status,
        code: ApiErrorCodes.UNAUTHORIZED,
        detail: authContext.error,
        hint: "Provide a valid `Authorization: Bearer <token>` header.",
        requestHeaders: request.headers,
      });
    }

    if (!authContext.userId) {
      return apiError({
        status: 401,
        code: ApiErrorCodes.UNAUTHORIZED,
        detail: "User context is required to create an integration",
        hint: "Sign in or supply a user-scoped API key (not an org-only key).",
        requestHeaders: request.headers,
      });
    }

    const { userId, organizationId } = authContext;

    const body: CreateIntegrationRequest = await request.json();

    if (!(body.type && body.config)) {
      return apiError({
        status: 400,
        code: ApiErrorCodes.INVALID_INPUT,
        detail: "Request body must include both `type` and `config` fields",
        hint: "See https://docs.keeperhub.com/api/integrations for the full request schema.",
        requestHeaders: request.headers,
      });
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
    // integration per org. Surface that as a 409 instead of falling
    // through to the generic 500.
    if (isUniqueViolation(error)) {
      return apiError({
        status: 409,
        code: "web3_integration_exists",
        detail: "This organization already has a web3 integration",
        hint: "Use GET /api/integrations?type=web3 to find the existing row, then DELETE it before creating a new one.",
        requestHeaders: request.headers,
      });
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
    return apiError({
      status: 500,
      code: ApiErrorCodes.INTERNAL_ERROR,
      detail: "Failed to create integration",
      hint: "Retry with backoff. If the error persists, check the request_id in server logs.",
      requestHeaders: request.headers,
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === "23505";
}
