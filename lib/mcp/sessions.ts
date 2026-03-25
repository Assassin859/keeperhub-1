import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpEventStore } from "@/lib/mcp/event-store";
import { logMcpEvent } from "@/lib/mcp/logging";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export type SessionEntry = {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  eventStore: McpEventStore;
  organizationId: string;
  apiKeyId: string;
  scope?: string;
  createdAt: number;
  lastActivity: number;
};

// Local in-process cache. The JWT session token is the source of truth.
// This cache is a performance optimisation: same-pod requests skip reconstruction.
// Cross-pod and post-restart requests fall back to JWT verification.
const localCache = new Map<string, SessionEntry>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function getSession(sessionId: string): SessionEntry | undefined {
  return localCache.get(sessionId);
}

export function setSession(sessionId: string, entry: SessionEntry): void {
  localCache.set(sessionId, entry);
  logMcpEvent("mcp.session.created", {
    sessionId,
    orgId: entry.organizationId,
  });
}

export function deleteSession(sessionId: string): void {
  const entry = localCache.get(sessionId);
  localCache.delete(sessionId);
  logMcpEvent("mcp.session.terminated", {
    sessionId,
    orgId: entry?.organizationId,
  });
}

export function touchSession(sessionId: string): void {
  const entry = localCache.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
  }
}

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, entry] of localCache) {
    if (now - entry.lastActivity > SESSION_TTL_MS) {
      entry.server.close().catch(() => undefined);
      entry.transport.close().catch(() => undefined);
      localCache.delete(sessionId);
      logMcpEvent("mcp.session.expired", {
        sessionId,
        orgId: entry.organizationId,
      });
    }
  }
}

export function getSessionCount(): number {
  return localCache.size;
}

export function startCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
  }
  cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
  if (
    cleanupTimer !== null &&
    typeof cleanupTimer === "object" &&
    "unref" in cleanupTimer
  ) {
    cleanupTimer.unref();
  }
}

export function stopCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
