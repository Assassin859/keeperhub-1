import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import {
  deserialize as v8Deserialize,
  serialize as v8Serialize,
} from "node:v8";
import { runCode } from "./run-code.js";

/**
 * Sentinel bytes byte-identical to the child_process runner. Main-app
 * client locates the serialized ChildOutcome by `lastIndexOf(sentinel)`
 * so stray user-code stdout writes cannot mask the real result.
 */
const RESULT_SENTINEL = "\u0001RESULT\u0002";

/** Hard cap to prevent oversized-body DoS. Anything larger is rejected. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Default timeout when the payload omits one — matches main-app default. */
const DEFAULT_TIMEOUT_SECONDS = 60;

type RunRequest = {
  code: unknown;
  timeout?: unknown;
};

const SANDBOX_PORT = Number.parseInt(process.env.SANDBOX_PORT ?? "8787", 10);

/** Read once at module init; exported for tests to verify the env wiring. */
export function getSandboxPort(): number {
  return SANDBOX_PORT;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function writeRunResult(res: ServerResponse, outcome: unknown): void {
  const payload = v8Serialize(outcome).toString("base64");
  res.writeHead(200, { "Content-Type": "application/octet-stream" });
  res.end(`${RESULT_SENTINEL}${payload}\n`);
}

function decodeRunRequest(raw: Buffer): RunRequest | null {
  try {
    const bodyBase64 = raw.toString("ascii").trim();
    const decoded = Buffer.from(bodyBase64, "base64");
    if (decoded.length === 0) {
      return null;
    }
    const deserialized = v8Deserialize(decoded);
    if (
      typeof deserialized !== "object" ||
      deserialized === null ||
      !("code" in deserialized)
    ) {
      return null;
    }
    return deserialized as RunRequest;
  } catch {
    return null;
  }
}

async function handlePostRun(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const raw = await readBody(req);
    if (raw.length === 0) {
      res.writeHead(400);
      res.end("empty body");
      return;
    }
    const request = decodeRunRequest(raw);
    if (request === null || typeof request.code !== "string") {
      res.writeHead(400);
      res.end("malformed body");
      return;
    }
    const timeoutSeconds =
      typeof request.timeout === "number"
        ? request.timeout
        : DEFAULT_TIMEOUT_SECONDS;
    const timeoutMs = Math.max(1, Math.min(120, timeoutSeconds)) * 1000;
    const outcome = await runCode({ code: request.code, timeoutMs });
    writeRunResult(res, outcome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // biome-ignore lint/suspicious/noConsole: sandbox runtime emits stderr for fatal paths so platform logs surface them
    console.error(`[Sandbox] /run failed: ${message}`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("sandbox internal error");
    }
  }
}

/**
 * Main HTTP request dispatcher. Separated from server creation so tests
 * can mount their own server on an ephemeral port.
 */
export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = (req.url ?? "").split("?")[0];

  if (req.method === "GET" && url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && url === "/run") {
    void handlePostRun(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
}

async function main(): Promise<void> {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      handleRequest(req, res);
    },
  );

  process.on("uncaughtException", (err: Error) => {
    // biome-ignore lint/suspicious/noConsole: fatal path; must surface to pod stderr before exit
    console.error(`[Fatal] uncaughtException: ${err.message}\n${err.stack ?? ""}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    // biome-ignore lint/suspicious/noConsole: fatal path; must surface to pod stderr before exit
    console.error(`[Fatal] unhandledRejection: ${message}`);
    process.exit(1);
  });

  const shutdown = async (signal: string): Promise<void> => {
    // biome-ignore lint/suspicious/noConsole: operator needs to see shutdown signals in pod logs
    console.log(`[Shutdown] received ${signal}`);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SANDBOX_PORT, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // biome-ignore lint/suspicious/noConsole: startup banner for operator visibility
  console.log(`[Sandbox] listening on :${SANDBOX_PORT}`);
}

// Only auto-start when executed directly, not when imported by tests.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.env.SANDBOX_AUTOSTART === "1"
) {
  void main();
}
