import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type ApiKeyAuthResult, authenticateApiKey } from "@/lib/api-key-auth";
import { McpEventStore } from "@/lib/mcp/event-store";
import { logMcpEvent } from "@/lib/mcp/logging";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { createMcpServer } from "@/lib/mcp/server";
import {
  createSessionToken,
  verifySessionToken,
} from "@/lib/mcp/session-token";
import {
  deleteSession,
  getSession,
  type SessionEntry,
  setSession,
  startCleanupInterval,
  touchSession,
} from "@/lib/mcp/sessions";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
} as const;

// Start the local-cache cleanup interval once per process lifetime.
startCleanupInterval();

const TRAILING_SLASH = /\/$/;

/**
 * Ensure the request carries the Accept header the MCP SDK requires.
 * Some MCP clients (e.g. Claude Code) omit `text/event-stream` from Accept,
 * which causes the SDK to return 406 even when `enableJsonResponse` is true.
 * We patch the header here so the transport's strict check passes.
 */
function ensureMcpAcceptHeader(request: Request): Request {
  const accept = request.headers.get("accept") ?? "";
  const hasJson = accept.includes("application/json");
  const hasSse = accept.includes("text/event-stream");

  if (hasJson && hasSse) {
    return request;
  }

  const parts = accept ? [accept] : [];
  if (!hasJson) {
    parts.push("application/json");
  }
  if (!hasSse) {
    parts.push("text/event-stream");
  }

  const headers = new Headers(request.headers);
  headers.set("accept", parts.join(", "));
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error -- duplex is required for streaming bodies in Node
    duplex: "half",
  });
}

function getBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function authenticate(request: Request): Promise<ApiKeyAuthResult> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : "";

  if (token.startsWith("kh_")) {
    return await authenticateApiKey(request);
  }

  const oauthResult = authenticateOAuthToken(request);
  if (oauthResult.authenticated) {
    return {
      authenticated: true,
      organizationId: oauthResult.organizationId,
      userId: oauthResult.userId,
      apiKeyId: `oauth:${oauthResult.userId ?? "unknown"}`,
      scope: oauthResult.scope,
    };
  }

  // Fall back to API key auth to get a consistent error format for non-OAuth tokens.
  return await authenticateApiKey(request);
}

function isInitializeRequestBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((item) => isInitializeRequest(item));
  }
  return isInitializeRequest(body);
}

function rateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32_029, message: "Rate limit exceeded" },
      id: null,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        ...CORS_HEADERS,
      },
    }
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

type BuiltSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  entry: SessionEntry;
};

function buildSession(
  sessionId: string,
  organizationId: string,
  apiKeyId: string,
  scope: string | undefined,
  baseUrl: string,
  authHeader: string
): BuiltSession {
  const eventStore = new McpEventStore();

  // Passing () => sessionId as the generator ensures the transport uses the
  // provided session ID both for fresh sessions and for reconstructed
  // cross-pod sessions, so it validates incoming Mcp-Session-Id headers correctly.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    eventStore,
    onsessioninitialized: (sid) => {
      setSession(sid, entry);
    },
    onsessionclosed: (sid) => {
      deleteSession(sid);
    },
    enableJsonResponse: true,
  });

  const server = createMcpServer(baseUrl, authHeader, scope);

  const entry: SessionEntry = {
    transport,
    server,
    eventStore,
    organizationId,
    apiKeyId,
    scope,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  return { transport, entry };
}

async function resolveSession(
  sessionId: string,
  organizationId: string,
  request: Request
): Promise<WebStandardStreamableHTTPServerTransport | null> {
  // Fast path: same-pod cache hit.
  const cached = getSession(sessionId);
  if (cached) {
    if (cached.organizationId !== organizationId) {
      return null;
    }
    touchSession(sessionId);
    return cached.transport;
  }

  // Slow path: verify JWT and reconstruct transport+server (different pod or restart).
  const payload = verifySessionToken(sessionId);
  if (!payload || payload.org !== organizationId) {
    return null;
  }

  logMcpEvent("mcp.session.reconstructed", {
    sessionId,
    orgId: organizationId,
  });

  const baseUrl = getBaseUrl(request);
  // Re-derive the auth header from the current request so tool calls in this
  // reconstructed session use the caller's credentials.
  const authHeader = request.headers.get("authorization") ?? "";
  const { transport, entry } = buildSession(
    sessionId,
    organizationId,
    payload.key,
    payload.scope,
    baseUrl,
    authHeader
  );

  await entry.server.connect(transport);

  // Cache locally for subsequent same-pod requests.
  setSession(sessionId, entry);

  return transport;
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.authenticated) {
    logMcpEvent("mcp.auth.failed", { reason: auth.error ?? "Unauthorized" });
    return new Response(
      JSON.stringify({ error: auth.error ?? "Unauthorized" }),
      {
        status: auth.statusCode ?? 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  const organizationId = auth.organizationId ?? "";

  const rateLimit = checkMcpRateLimit(organizationId);
  if (!rateLimit.allowed) {
    logMcpEvent("mcp.rate.limited", { orgId: organizationId });
    return rateLimitResponse(rateLimit.retryAfter);
  }

  const sessionId = request.headers.get("mcp-session-id");

  if (sessionId) {
    const existingTransport = await resolveSession(
      sessionId,
      organizationId,
      request
    );
    if (!existingTransport) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    return existingTransport.handleRequest(ensureMcpAcceptHeader(request));
  }

  // No session ID: must be an initialize request.
  // Pre-parse body because request.json() consumes the stream.
  // We pass parsedBody to handleRequest so the SDK does not re-read it.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  if (!isInitializeRequestBody(body)) {
    return new Response(
      JSON.stringify({
        error: "Missing mcp-session-id header for non-initialize requests",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  if (!(auth.organizationId && auth.apiKeyId)) {
    return new Response(
      JSON.stringify({ error: "API key missing organization context" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  const apiKeyId = auth.apiKeyId;
  // OAuth tokens carry a scope string; API keys have full access (undefined scope).
  const scope = auth.scope;

  // Mint the JWT that becomes the Mcp-Session-Id returned to the client.
  // Any pod can verify and reconstruct state from this token on future requests.
  const newSessionId = createSessionToken({
    org: organizationId,
    key: apiKeyId,
    scope,
  });

  const baseUrl = getBaseUrl(request);
  const authHeader = request.headers.get("authorization") ?? "";
  const { transport, entry } = buildSession(
    newSessionId,
    organizationId,
    apiKeyId,
    scope,
    baseUrl,
    authHeader
  );

  await entry.server.connect(transport);

  return transport.handleRequest(ensureMcpAcceptHeader(request), {
    parsedBody: body,
  });
}

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.authenticated) {
    logMcpEvent("mcp.auth.failed", { reason: auth.error ?? "Unauthorized" });
    return new Response(
      JSON.stringify({ error: auth.error ?? "Unauthorized" }),
      {
        status: auth.statusCode ?? 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return new Response(
      JSON.stringify({ error: "Missing mcp-session-id header" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  const organizationId = auth.organizationId ?? "";
  const transport = await resolveSession(sessionId, organizationId, request);
  if (!transport) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  return transport.handleRequest(ensureMcpAcceptHeader(request));
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.authenticated) {
    logMcpEvent("mcp.auth.failed", { reason: auth.error ?? "Unauthorized" });
    return new Response(
      JSON.stringify({ error: auth.error ?? "Unauthorized" }),
      {
        status: auth.statusCode ?? 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return new Response(
      JSON.stringify({ error: "Missing mcp-session-id header" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  const organizationId = auth.organizationId ?? "";

  // Verify ownership via JWT before touching anything in the local cache.
  const payload = verifySessionToken(sessionId);
  if (!payload || payload.org !== organizationId) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // Close and evict from local cache if present on this pod.
  const cached = getSession(sessionId);
  if (cached) {
    await cached.server.close();
    await cached.transport.close();
    deleteSession(sessionId);
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
