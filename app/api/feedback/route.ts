import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

const FEEDBACK_SERVICE_URL = process.env.FEEDBACK_SERVICE_URL || "";
const FEEDBACK_API_KEY = process.env.FEEDBACK_API_KEY || "";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // Validate configuration
    if (!FEEDBACK_SERVICE_URL) {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Feedback] FEEDBACK_SERVICE_URL not configured",
        new Error(
          "FEEDBACK_SERVICE_URL environment variable is not configured"
        ),
        {
          endpoint: "/api/feedback",
          component: "feedback-service",
        }
      );
      return NextResponse.json(
        { error: "Feedback service not configured" },
        { status: 500 }
      );
    }

    if (!FEEDBACK_API_KEY) {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Feedback] FEEDBACK_API_KEY not configured",
        new Error("FEEDBACK_API_KEY environment variable is not configured"),
        {
          endpoint: "/api/feedback",
          component: "feedback-service",
        }
      );
      return NextResponse.json(
        { error: "Feedback service not configured" },
        { status: 500 }
      );
    }

    // Auth is optional. Either a session cookie or an API key attaches user
    // context for the support team; unauthenticated callers still go through.
    const authContext = await getDualAuthContext(request, { required: false });
    const callerUserId =
      "error" in authContext ? null : (authContext.userId ?? null);

    let callerName: string | null = null;
    let callerEmail: string | null = null;
    if (callerUserId) {
      const callerRow = await db.query.users.findFirst({
        where: eq(users.id, callerUserId),
        columns: { name: true, email: true },
      });
      callerName = callerRow?.name ?? null;
      callerEmail = callerRow?.email ?? null;
    }

    const formData = await request.formData();
    const message = formData.get("message") as string;
    const categories = formData.get("categories") as string;
    const screenshot = formData.get("screenshot") as File | null;

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    const serviceFormData = new FormData();
    serviceFormData.append("message", message.trim());

    if (categories) {
      serviceFormData.append("categories", categories);
    }

    if (screenshot) {
      serviceFormData.append("screenshot", screenshot);
    }

    if (callerEmail || callerName) {
      serviceFormData.append("userEmail", callerEmail ?? "");
      serviceFormData.append("userName", callerName ?? "");
    }

    // Forward to feedback service
    const response = await fetch(FEEDBACK_SERVICE_URL, {
      method: "POST",
      headers: {
        "X-API-Key": FEEDBACK_API_KEY,
      },
      body: serviceFormData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Feedback] Service error",
        new Error(JSON.stringify(errorData)),
        { endpoint: "/api/feedback", operation: "post" }
      );
      return NextResponse.json(
        { error: errorData.error || "Failed to submit feedback" },
        { status: response.status }
      );
    }

    const result = await response.json();
    return NextResponse.json(result);
  } catch (error) {
    logSystemError(ErrorCategory.EXTERNAL_SERVICE, "[Feedback] Error", error, {
      endpoint: "/api/feedback",
      operation: "post",
    });
    return NextResponse.json(
      { error: "Failed to submit feedback" },
      { status: 500 }
    );
  }
}
