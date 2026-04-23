import "server-only";

import { Agent, request as httpRequest } from "node:http";
import {
  deserialize as v8Deserialize,
  serialize as v8Serialize,
} from "node:v8";

const SANDBOX_URL = process.env.SANDBOX_URL ?? "http://localhost:8787";
const RESULT_SENTINEL = "\u0001RESULT\u0002";

const sandboxAgent = new Agent({
  keepAlive: true,
  maxSockets: 50,
});

type LogEntry = {
  level: "log" | "warn" | "error";
  args: unknown[];
};

type ChildOutcome =
  | { ok: true; result: unknown; logs: LogEntry[] }
  | {
      ok: false;
      errorMessage: string;
      errorStack?: string;
      logs: LogEntry[];
    };

export type RunCodeResult =
  | { success: true; result: unknown; logs: LogEntry[] }
  | { success: false; error: string; logs: LogEntry[]; line?: number };

const VM_LINE_REGEX = /user-code\.js:(\d+)/;

function extractLineNumber(stack: string | undefined): number | undefined {
  if (!stack) {
    return undefined;
  }
  const match = stack.match(VM_LINE_REGEX);
  if (match?.[1]) {
    const rawLine = Number.parseInt(match[1], 10);
    return Math.max(1, rawLine - 1);
  }
  return undefined;
}

function postOnce(body: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const url = new URL("/run", SANDBOX_URL);
    const port = url.port
      ? Number.parseInt(url.port, 10)
      : url.protocol === "https:"
        ? 443
        : 80;
    const req = httpRequest(
      {
        agent: sandboxAgent,
        protocol: url.protocol,
        hostname: url.hostname,
        port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": body.length.toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `sandbox returned ${res.statusCode ?? "no status"}: ${buf.toString("utf8").slice(0, 200)}`,
              ),
            );
            return;
          }
          resolve(buf);
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseResponse(buf: Buffer): ChildOutcome {
  const text = buf.toString("utf8");
  const idx = text.lastIndexOf(RESULT_SENTINEL);
  if (idx === -1) {
    throw new Error("sandbox response missing sentinel");
  }
  const payload = text.slice(idx + RESULT_SENTINEL.length).trim();
  const decoded = Buffer.from(payload, "base64");
  return v8Deserialize(decoded) as ChildOutcome;
}

function toRunCodeResult(outcome: ChildOutcome): RunCodeResult {
  if (outcome.ok) {
    return { success: true, result: outcome.result, logs: outcome.logs };
  }
  const line = extractLineNumber(outcome.errorStack);
  const base: RunCodeResult = {
    success: false,
    error: outcome.errorMessage,
    logs: outcome.logs,
  };
  if (line !== undefined) {
    base.line = line;
  }
  return base;
}

export async function runRemote(input: {
  code: string;
  timeoutMs: number;
}): Promise<RunCodeResult> {
  try {
    const timeoutSeconds = Math.ceil(input.timeoutMs / 1000);
    const body = Buffer.from(
      v8Serialize({ code: input.code, timeout: timeoutSeconds }).toString(
        "base64",
      ),
      "ascii",
    );
    const responseBuf = await postOnce(body);
    const outcome = parseResponse(responseBuf);
    return toRunCodeResult(outcome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `sandbox client error: ${message}`,
      logs: [],
    };
  }
}
