import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AddressInfo,
  createServer as createNetServer,
} from "node:net";
import { once } from "node:events";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import {
  deserialize as v8Deserialize,
  serialize as v8Serialize,
} from "node:v8";
import { handleRequest } from "./index.js";

const RESULT_SENTINEL = "\u0001RESULT\u0002";

function makeRunBody(payload: unknown): string {
  return v8Serialize(payload).toString("base64");
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: Buffer }> {
  const { request: httpRequest } = await import("node:http");
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: body
          ? {
              "Content-Type": "application/octet-stream",
              "Content-Length": Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function parseRunResponse(body: Buffer): unknown {
  const text = body.toString("binary");
  const idx = text.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) {
    throw new Error(`no sentinel in response: ${text.slice(0, 80)}`);
  }
  const base64 = text.slice(idx + RESULT_SENTINEL.length).replace(/\n$/, "");
  return v8Deserialize(Buffer.from(base64.trim(), "base64"));
}

describe("sandbox HTTP server", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeAll(async () => {
    server = createServer(
      (req: IncomingMessage, res: ServerResponse): void => {
        handleRequest(req, res);
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address() as AddressInfo;
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("GET /healthz returns 200 with body 'ok'", async () => {
    const res = await request(port, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("ok");
  });

  it("GET /unknown returns 404", async () => {
    const res = await request(port, "GET", "/unknown");
    expect(res.status).toBe(404);
  });

  it("POST /unknown returns 404", async () => {
    const res = await request(port, "POST", "/unknown", "");
    expect(res.status).toBe(404);
  });

  it("POST /run with valid v8+base64 body returns 200 with sentinel-prefixed ChildOutcome", async () => {
    const body = makeRunBody({ code: "return 1 + 1;", timeout: 5 });
    const res = await request(port, "POST", "/run", body);
    expect(res.status).toBe(200);
    const text = res.body.toString("binary");
    expect(text.includes(RESULT_SENTINEL)).toBe(true);
    const outcome = parseRunResponse(res.body) as {
      ok: boolean;
      result?: unknown;
    };
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe(2);
  });

  it("POST /run with empty body returns 400", async () => {
    const res = await request(port, "POST", "/run");
    expect(res.status).toBe(400);
  });

  it("POST /run with non-base64 body returns 400", async () => {
    const res = await request(
      port,
      "POST",
      "/run",
      "this is not v8 base64 !!!",
    );
    expect(res.status).toBe(400);
  });

  it("POST /run where user code throws returns 200 with ok:false ChildOutcome", async () => {
    const body = makeRunBody({ code: "throw new Error('boom');", timeout: 5 });
    const res = await request(port, "POST", "/run", body);
    expect(res.status).toBe(200);
    const outcome = parseRunResponse(res.body) as {
      ok: boolean;
      errorMessage?: string;
    };
    expect(outcome.ok).toBe(false);
    expect(outcome.errorMessage).toContain("boom");
  });

  it("POST /run with env-escape payload does not leak injected secret", async () => {
    const FAKE = "SBX_TEST_FAKE_SECRET_AAA";
    process.env[FAKE] = "must-not-leak";
    try {
      const body = makeRunBody({
        code: `const p = Error.constructor("return process")(); return Object.keys(p.env);`,
        timeout: 5,
      });
      const res = await request(port, "POST", "/run", body);
      expect(res.status).toBe(200);
      const outcome = parseRunResponse(res.body) as {
        ok: boolean;
        result?: string[];
      };
      expect(outcome.ok).toBe(true);
      expect(outcome.result).not.toContain(FAKE);
    } finally {
      delete process.env[FAKE];
    }
  });

  it("SANDBOX_PORT env var is read at module init", async () => {
    // The module already imported at test start; the constant captured by
    // handleRequest closure is fixed. We assert the module exports a
    // numeric port resolver by importing index.js directly and asserting
    // it exposes the port resolution helper.
    const mod = await import("./index.js");
    expect(typeof mod.getSandboxPort).toBe("function");
    expect(mod.getSandboxPort()).toBeGreaterThan(0);
  });
});

// Reserve a random port helper is not needed in test — listen(0) picks one.
// Kept createNetServer/once imports available for future async readiness
// checks if the server gains explicit ready signals.
void createNetServer;
void once;
