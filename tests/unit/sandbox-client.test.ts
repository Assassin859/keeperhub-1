import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  deserialize as v8Deserialize,
  serialize as v8Serialize,
} from "node:v8";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const RESULT_SENTINEL = "\u0001RESULT\u0002";

type MockResponder = (req: {
  body: unknown;
}) => { status: number; body: string };

let port = 0;
let server: Server;
let currentResponder: MockResponder | null = null;
let connectionCount = 0;

async function readReqBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function decodeRunPayload(raw: Buffer): unknown {
  const base64 = raw.toString("ascii").trim();
  const decoded = Buffer.from(base64, "base64");
  return v8Deserialize(decoded);
}

beforeAll(async () => {
  server = createServer(
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const body = await readReqBody(req);
      const parsed = decodeRunPayload(body);
      if (!currentResponder) {
        res.writeHead(500);
        res.end("no responder registered");
        return;
      }
      const result = currentResponder({ body: parsed });
      res.writeHead(result.status, {
        "Content-Type": "application/octet-stream",
      });
      res.end(result.body);
    },
  );

  server.on("connection", () => {
    connectionCount += 1;
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  delete process.env.SANDBOX_URL;
});

function sentinelBody(outcome: unknown): string {
  const payload = v8Serialize(outcome).toString("base64");
  return `${RESULT_SENTINEL}${payload}\n`;
}

describe("lib/sandbox-client runRemote", () => {
  it("returns success:true for a valid ok:true ChildOutcome response", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: 2, logs: [] }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox-client");
    const outcome = await runRemote({ code: "return 1 + 1;", timeoutMs: 5000 });
    expect(outcome).toEqual({ success: true, result: 2, logs: [] });
  });

  it("round-trips BigInt across the wire", async () => {
    const big = BigInt("1267650600228229401496703205376");
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: big, logs: [] }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox-client");
    const outcome = await runRemote({ code: "doesnt matter", timeoutMs: 1000 });
    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.result).toBe(big);
    }
  });

  it("maps ok:false to success:false with error message and line number", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({
        ok: false,
        errorMessage: "boom",
        errorStack: "Error: boom\n    at user-code.js:4",
        logs: [],
      }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox-client");
    const outcome = await runRemote({
      code: "throw new Error('boom');",
      timeoutMs: 1000,
    });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toBe("boom");
      expect(outcome.line).toBe(3);
    }
  });

  it("reuses a single TCP socket across N sequential runRemote calls (keep-alive)", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: 0, logs: [] }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox-client");
    const startConnections = connectionCount;
    for (const _iteration of [1, 2, 3, 4, 5]) {
      void _iteration;
      await runRemote({ code: "return 0;", timeoutMs: 1000 });
    }
    const delta = connectionCount - startConnections;
    expect(delta).toBeLessThanOrEqual(1);
  });

  it("returns success:false when sandbox is unreachable (no throw)", async () => {
    const saved = process.env.SANDBOX_URL;
    process.env.SANDBOX_URL = "http://127.0.0.1:1";
    try {
      vi.resetModules();
      const { runRemote } = await import("@/lib/sandbox-client");
      const outcome = await runRemote({
        code: "return 1;",
        timeoutMs: 1000,
      });
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error).toContain("sandbox client error");
      }
    } finally {
      process.env.SANDBOX_URL = saved;
      vi.resetModules();
    }
  });

  it("uses lastIndexOf to tolerate forged sentinels earlier in output", async () => {
    const fakePayload = Buffer.from([0xff, 0xff, 0xff]).toString("base64");
    const realPayload = v8Serialize({
      ok: true,
      result: "real",
      logs: [],
    }).toString("base64");
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: `noise${RESULT_SENTINEL}${fakePayload}\n${RESULT_SENTINEL}${realPayload}\n`,
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox-client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.result).toBe("real");
    }
  });

  it("sends timeout in SECONDS in the v8 payload", async () => {
    let capturedPayload: unknown = null;
    currentResponder = ({ body }): { status: number; body: string } => {
      capturedPayload = body;
      return {
        status: 200,
        body: sentinelBody({ ok: true, result: null, logs: [] }),
      };
    };
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox-client");
    await runRemote({ code: "return null;", timeoutMs: 5000 });
    expect(capturedPayload).toMatchObject({
      code: "return null;",
      timeout: 5,
    });
  });

  it("returns success:false when response is missing the sentinel", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: "garbage without sentinel",
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox-client");
    const outcome = await runRemote({ code: "return 1;", timeoutMs: 1000 });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toContain("sandbox client error");
    }
  });
});
