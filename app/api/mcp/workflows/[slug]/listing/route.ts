import { NextResponse } from "next/server";
import {
  getWorkflowListing,
  type ListingErrorDetails,
  type ListWorkflowMetadata,
  listWorkflow,
  type UpdateWorkflowPatch,
  unlistWorkflow,
  updateWorkflowListing,
} from "@/lib/mcp/listing";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { sanitizeDescription } from "@/lib/sanitize-description";

const LISTING_RATE_LIMIT = 60;
const LISTING_RATE_WINDOW_MS = 60_000;

type RouteContext = { params: Promise<{ slug: string }> };

function mapListingError(
  error: string,
  details?: ListingErrorDetails
): NextResponse {
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
  if (error === "MISSING_WRITE_ACTION") {
    return NextResponse.json(
      {
        error: "MISSING_WRITE_ACTION",
        message:
          "Workflows listed as workflowType='write' must contain at least one write-contract or protocol-write action node. Add the action to the workflow before listing it.",
      },
      { status: 422 }
    );
  }
  if (error === "INVALID_TEMPLATE_LITERALS") {
    return NextResponse.json(
      {
        error: "INVALID_TEMPLATE_LITERALS",
        message:
          "One or more node config fields contain a bare `@<word>` literal outside a `{{...}}` template wrapper. This usually means the editor's `@` autocomplete was dismissed before the reference was completed. Re-open the workflow, replace the literal with a proper `{{@nodeId:Label.field}}` reference, and try listing again.",
        ...(details?.literals && details.literals.length > 0
          ? { literals: details.literals }
          : {}),
      },
      { status: 422 }
    );
  }
  if (error === "INPUT_SCHEMA_REQUIRED") {
    return NextResponse.json(
      {
        error: "INPUT_SCHEMA_REQUIRED",
        message:
          'Listed workflows must declare an `inputSchema`. Set it to a JSON-schema-shaped object (`{"type": "object"}` is fine for workflows that take no inputs).',
      },
      { status: 422 }
    );
  }
  return NextResponse.json(
    { error: "INVALID_INPUT", message: "Invalid request." },
    { status: 400 }
  );
}

// GET — public read by listedSlug. The `slug` URL segment is the listed slug.
export async function GET(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = checkIpRateLimit(
      clientIp,
      LISTING_RATE_LIMIT,
      LISTING_RATE_WINDOW_MS
    );
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "Retry-After": String(rateCheck.retryAfter) },
        }
      );
    }

    const { slug } = await params;
    const result = await getWorkflowListing(slug);

    if (!result.ok) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    const listing = {
      ...result.listing,
      description: result.listing.description
        ? sanitizeDescription(result.listing.description)
        : null,
    };

    return NextResponse.json(listing, {
      headers: {
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST/PATCH/DELETE — curator mutations. The `slug` URL segment is the workflowId.
// Named `slug` in the route file because the parent directory `[slug]` must use
// a single param name across siblings (Next.js constraint, shared with [slug]/call).

export async function POST(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return NextResponse.json(
      { error: authContext.error },
      { status: authContext.status }
    );
  }

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json(
      { error: "Organization required" },
      { status: 401 }
    );
  }

  const { slug: workflowId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawBody = body as Record<string, unknown>;
  const metadata: ListWorkflowMetadata = {
    slug: typeof rawBody.slug === "string" ? rawBody.slug : undefined,
    category:
      typeof rawBody.category === "string" ? rawBody.category : undefined,
    chain: typeof rawBody.chain === "string" ? rawBody.chain : undefined,
    inputSchema:
      rawBody.inputSchema !== null && typeof rawBody.inputSchema === "object"
        ? (rawBody.inputSchema as Record<string, unknown>)
        : undefined,
    outputMapping:
      rawBody.outputMapping !== null &&
      typeof rawBody.outputMapping === "object"
        ? (rawBody.outputMapping as Record<string, unknown>)
        : undefined,
    workflowType:
      typeof rawBody.workflowType === "string"
        ? rawBody.workflowType
        : undefined,
  };

  const result = await listWorkflow(workflowId, organizationId, metadata);
  if (!result.ok) {
    return mapListingError(result.error, result.details);
  }

  return NextResponse.json(result.listing, { status: 200 });
}

export async function PATCH(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return NextResponse.json(
      { error: authContext.error },
      { status: authContext.status }
    );
  }

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json(
      { error: "Organization required" },
      { status: 401 }
    );
  }

  const { slug: workflowId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawBody = body as Record<string, unknown>;
  const patch: UpdateWorkflowPatch = {
    category:
      typeof rawBody.category === "string" ? rawBody.category : undefined,
    chain: typeof rawBody.chain === "string" ? rawBody.chain : undefined,
    inputSchema:
      rawBody.inputSchema !== null && typeof rawBody.inputSchema === "object"
        ? (rawBody.inputSchema as Record<string, unknown>)
        : undefined,
    outputMapping:
      rawBody.outputMapping !== null &&
      typeof rawBody.outputMapping === "object"
        ? (rawBody.outputMapping as Record<string, unknown>)
        : undefined,
    workflowType:
      typeof rawBody.workflowType === "string"
        ? rawBody.workflowType
        : undefined,
    priceUsdcPerCall:
      typeof rawBody.priceUsdcPerCall === "string"
        ? rawBody.priceUsdcPerCall
        : undefined,
  };

  const result = await updateWorkflowListing(workflowId, organizationId, patch);
  if (!result.ok) {
    return mapListingError(result.error, result.details);
  }

  return NextResponse.json(result.listing, { status: 200 });
}

export async function DELETE(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return NextResponse.json(
      { error: authContext.error },
      { status: authContext.status }
    );
  }

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json(
      { error: "Organization required" },
      { status: 401 }
    );
  }

  const { slug: workflowId } = await params;

  const result = await unlistWorkflow(workflowId, organizationId);
  if (!result.ok) {
    return mapListingError(result.error, result.details);
  }

  return NextResponse.json(result.listing, { status: 200 });
}
