/**
 * Probe MCP session-cache caps on a remote keeperhub deployment.
 *
 * Black-box client that opens N sequential MCP sessions against the same
 * API key, optionally revisits each one to verify post-eviction
 * transparency, and prints a JSON report. Pair with `kubectl logs` on
 * the target pod to see `mcp.session.evicted` events from the server side.
 *
 * Usage:
 *   KEEPERHUB_API_KEY=kh_... pnpm tsx scripts/probe-mcp-cap.ts \
 *     --base-url https://app-staging.keeperhub.com \
 *     --sessions 10 \
 *     --revisit
 *
 * What to look for:
 *   - Pre-fix (no caps): all sessions stay cached, revisit times match
 *     init times closely, server memory grows.
 *   - Post-fix (per-key cap = 5): the 6th session evicts the 1st.
 *     Revisiting evicted sessions still succeeds (the JWT is valid;
 *     the server reconstructs the session via verifyJWT slow path) but
 *     takes longer. Server log emits `mcp.session.evicted reason=per_key_cap`.
 */

const PROTOCOL_VERSION = "2025-06-18";
const ACCEPT = "application/json, text/event-stream";

type Args = {
  baseUrl: string;
  sessions: number;
  revisit: boolean;
};

type SessionResult = {
  index: number;
  initMs: number;
  sessionId: string | null;
  success: boolean;
  error?: string;
};

type RevisitResult = {
  index: number;
  sessionIdShort: string;
  revisitMs: number;
  success: boolean;
  error?: string;
};

type Report = {
  baseUrl: string;
  sessions: SessionResult[];
  revisits: RevisitResult[];
  summary: {
    opened: number;
    failed: number;
    initP50Ms: number;
    initP95Ms: number;
    revisitP50Ms: number | null;
    revisitP95Ms: number | null;
    revisitVsInitDeltaP50Ms: number | null;
  };
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: process.env.BASE_URL ?? "https://app-staging.keeperhub.com",
    sessions: 10,
    revisit: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--base-url" && argv[i + 1] !== undefined) {
      args.baseUrl = argv[i + 1] as string;
      i += 1;
    } else if (flag === "--sessions" && argv[i + 1] !== undefined) {
      args.sessions = Number.parseInt(argv[i + 1] as string, 10);
      i += 1;
    } else if (flag === "--revisit") {
      args.revisit = true;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: KEEPERHUB_API_KEY=kh_... tsx scripts/probe-mcp-cap.ts " +
          "[--base-url URL] [--sessions N] [--revisit]\n"
      );
      process.exit(0);
    }
  }
  return args;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  );
  return sorted[idx] ?? 0;
}

async function openSession(
  baseUrl: string,
  apiKey: string,
  index: number
): Promise<SessionResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: ACCEPT,
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "probe-mcp-cap", version: "0" },
        },
      }),
    });
    const initMs = performance.now() - start;
    const sessionId = res.headers.get("mcp-session-id");
    if (!res.ok || sessionId === null) {
      const body = await res.text();
      return {
        index,
        initMs,
        sessionId: null,
        success: false,
        error: `HTTP ${res.status} sid=${sessionId ?? "<none>"} body=${body.slice(0, 200)}`,
      };
    }
    return { index, initMs, sessionId, success: true };
  } catch (err) {
    return {
      index,
      initMs: performance.now() - start,
      sessionId: null,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function listTools(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  index: number
): Promise<RevisitResult> {
  const start = performance.now();
  const sessionIdShort = `${sessionId.slice(0, 12)}...${sessionId.slice(-8)}`;
  try {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: ACCEPT,
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });
    const revisitMs = performance.now() - start;
    if (!res.ok) {
      const body = await res.text();
      return {
        index,
        sessionIdShort,
        revisitMs,
        success: false,
        error: `HTTP ${res.status} body=${body.slice(0, 200)}`,
      };
    }
    return { index, sessionIdShort, revisitMs, success: true };
  } catch (err) {
    return {
      index,
      sessionIdShort,
      revisitMs: performance.now() - start,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "Missing KEEPERHUB_API_KEY env var. Get one from your kh CLI " +
        "config (~/.config/kh/hosts.yml) or generate via the app.\n"
    );
    process.exit(1);
  }

  process.stderr.write(
    `Opening ${args.sessions} sessions against ${args.baseUrl}/mcp ...\n`
  );

  const sessionResults: SessionResult[] = [];
  for (let i = 0; i < args.sessions; i += 1) {
    const r = await openSession(args.baseUrl, apiKey, i);
    sessionResults.push(r);
    process.stderr.write(
      `  [${i}] ${r.success ? "OK" : "FAIL"} ${r.initMs.toFixed(0)}ms` +
        `${r.error ? ` (${r.error})` : ""}\n`
    );
  }

  const revisitResults: RevisitResult[] = [];
  if (args.revisit) {
    process.stderr.write("\nRevisiting all sessions to detect evictions ...\n");
    for (const s of sessionResults) {
      if (s.sessionId === null) {
        continue;
      }
      const r = await listTools(args.baseUrl, apiKey, s.sessionId, s.index);
      revisitResults.push(r);
      process.stderr.write(
        `  [${r.index}] ${r.success ? "OK" : "FAIL"} ${r.revisitMs.toFixed(0)}ms` +
          `${r.error ? ` (${r.error})` : ""}\n`
      );
    }
  }

  const initTimes = sessionResults
    .filter((r) => r.success)
    .map((r) => r.initMs);
  const revisitTimes = revisitResults
    .filter((r) => r.success)
    .map((r) => r.revisitMs);
  const initP50 = percentile(initTimes, 50);

  const report: Report = {
    baseUrl: args.baseUrl,
    sessions: sessionResults.map((r) => ({
      ...r,
      sessionId:
        r.sessionId === null
          ? null
          : `${r.sessionId.slice(0, 12)}...${r.sessionId.slice(-8)}`,
    })),
    revisits: revisitResults,
    summary: {
      opened: sessionResults.filter((r) => r.success).length,
      failed: sessionResults.filter((r) => !r.success).length,
      initP50Ms: Math.round(initP50),
      initP95Ms: Math.round(percentile(initTimes, 95)),
      revisitP50Ms:
        revisitTimes.length > 0
          ? Math.round(percentile(revisitTimes, 50))
          : null,
      revisitP95Ms:
        revisitTimes.length > 0
          ? Math.round(percentile(revisitTimes, 95))
          : null,
      revisitVsInitDeltaP50Ms:
        revisitTimes.length > 0
          ? Math.round(percentile(revisitTimes, 50) - initP50)
          : null,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    "\nServer-side: tail keeperhub-common pod logs for " +
      "`mcp.session.created`, `mcp.session.reconstructed`, and " +
      "`mcp.session.evicted` events to confirm cap behaviour.\n"
  );
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
