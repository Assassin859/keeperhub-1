import { NextResponse } from "next/server";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import {
  listWorkflow,
  unlistWorkflow,
  updateWorkflowListing,
  type ListWorkflowMetadata,
  type UpdateWorkflowPatch,
} from "@/lib/mcp/listing";

type RouteContext = { params: Promise<{ id: string }> };

function mapListingError(error: string): NextResponse {
  if (error === "NOT_FOUND") {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
  if (error === "SLUG_CONFLICT") {
    return NextResponse.json(
      {
        error: "SLUG_CONFLICT",
        message: "This slug is already in use by another listed workflow.",
      },
      { status: 409 }
    );
  }
  if (error === "PRICE_CHANGE_WHILE_LISTED") {
    return NextResponse.json(
      {
        error: "PRICE_CHANGE_WHILE_LISTED",
        message: "Unlist the workflow before changing the price.",
      },
      { status: 409 }
    );
  }
  return NextResponse.json(
    { error: "INVALID_INPUT", message: "Invalid request." },
    { status: 400 }
  );
}

export async function POST(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return NextResponse.json({ error: authContext.error }, { status: authContext.status });
  }

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json({ error: "Organization required" }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawBody = body as Record<string, unknown>;
  const metadata: ListWorkflowMetadata = {
    slug: typeof rawBody.slug === "string" ? rawBody.slug : undefined,
    category: typeof rawBody.category === "string" ? rawBody.category : undefined,
    chain: typeof rawBody.chain === "string" ? rawBody.chain : undefined,
    inputSchema:
      rawBody.inputSchema !== null && typeof rawBody.inputSchema === "object"
        ? (rawBody.inputSchema as Record<string, unknown>)
        : undefined,
    outputMapping:
      rawBody.outputMapping !== null && typeof rawBody.outputMapping === "object"
        ? (rawBody.outputMapping as Record<string, unknown>)
        : undefined,
    workflowType:
      typeof rawBody.workflowType === "string" ? rawBody.workflowType : undefined,
  };

  const result = await listWorkflow(id, organizationId, metadata);
  if (!result.ok) {
    return mapListingError(result.error);
  }

  return NextResponse.json(result.listing, { status: 200 });
}

export async function PATCH(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return NextResponse.json({ error: authContext.error }, { status: authContext.status });
  }

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json({ error: "Organization required" }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawBody = body as Record<string, unknown>;
  const patch: UpdateWorkflowPatch = {
    category: typeof rawBody.category === "string" ? rawBody.category : undefined,
    chain: typeof rawBody.chain === "string" ? rawBody.chain : undefined,
    inputSchema:
      rawBody.inputSchema !== null && typeof rawBody.inputSchema === "object"
        ? (rawBody.inputSchema as Record<string, unknown>)
        : undefined,
    outputMapping:
      rawBody.outputMapping !== null && typeof rawBody.outputMapping === "object"
        ? (rawBody.outputMapping as Record<string, unknown>)
        : undefined,
    workflowType:
      typeof rawBody.workflowType === "string" ? rawBody.workflowType : undefined,
    priceUsdcPerCall:
      typeof rawBody.priceUsdcPerCall === "string" ? rawBody.priceUsdcPerCall : undefined,
  };

  const result = await updateWorkflowListing(id, organizationId, patch);
  if (!result.ok) {
    return mapListingError(result.error);
  }

  return NextResponse.json(result.listing, { status: 200 });
}

export async function DELETE(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return NextResponse.json({ error: authContext.error }, { status: authContext.status });
  }

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json({ error: "Organization required" }, { status: 401 });
  }

  const { id } = await params;

  const result = await unlistWorkflow(id, organizationId);
  if (!result.ok) {
    return mapListingError(result.error);
  }

  return NextResponse.json(result.listing, { status: 200 });
}
