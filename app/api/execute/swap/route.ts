import "server-only";

import { NextResponse } from "next/server";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { validateApiKey } from "../_lib/auth";

export async function POST(request: Request): Promise<NextResponse> {
  const apiKeyCtx = await validateApiKey(request);
  if (!apiKeyCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const scopeError = requireScope(apiKeyCtx.scope, SCOPE_MCP_WRITE);
  if (scopeError) {
    return scopeError;
  }

  return NextResponse.json({ message: "Coming soon" }, { status: 501 });
}
