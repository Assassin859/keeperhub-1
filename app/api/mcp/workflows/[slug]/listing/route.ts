import { NextResponse } from "next/server";
import { getWorkflowListing } from "@/lib/mcp/listing";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { sanitizeDescription } from "@/lib/sanitize-description";

const LISTING_RATE_LIMIT = 60;
const LISTING_RATE_WINDOW_MS = 60_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = checkIpRateLimit(clientIp, LISTING_RATE_LIMIT, LISTING_RATE_WINDOW_MS);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(rateCheck.retryAfter) } }
      );
    }

    const { slug } = await params;
    const result = await getWorkflowListing(slug);

    if (!result.ok) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    const listing = {
      ...result.listing,
      description:
        result.listing.description
          ? sanitizeDescription(result.listing.description)
          : null,
    };

    return NextResponse.json(listing, {
      headers: {
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
