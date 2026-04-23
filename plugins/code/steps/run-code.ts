import "server-only";

import { spawn } from "node:child_process";
import { deserialize } from "node:v8";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { runRemote } from "@/lib/sandbox-client";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";

type LogEntry = {
  level: "log" | "warn" | "error";
  args: unknown[];
};

type RunCodeResult =
  | { success: true; result: unknown; logs: LogEntry[] }
  | { success: false; error: string; logs: LogEntry[]; line?: number };

export type RunCodeCoreInput = {
  code: string;
  timeout?: number;
};

export type RunCodeInput = StepInput & RunCodeCoreInput;

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 120;
const UNRESOLVED_TEMPLATE_REGEX = /\{\{@?[^}]+\}\}/g;
const VM_LINE_REGEX = /user-code\.js:(\d+)/;

/**
 * Backend selector read once at module init — "local" means the in-pod
 * child_process path (the PR #953 runner inlined below), "remote" dispatches
 * to the standalone sandbox HTTP service via `lib/sandbox-client.ts`. Default
 * is "local" so dev and unit tests stay on the in-pod runner without extra
 * env wiring.
 */
const SANDBOX_BACKEND = process.env.SANDBOX_BACKEND ?? "local";

const JS_STRING_LITERAL_REGEX =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function stripStringLiterals(code: string): string {
  return code.replace(JS_STRING_LITERAL_REGEX, "");
}

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

const CHILD_ENV_ALLOWLIST = [
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "TZ",
  "LANG",
  "LC_ALL",
] as const;

function buildChildEnv(): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as NodeJS.ProcessEnv;
}

const CHILD_SOURCE = `
"use strict";
const { createContext, runInContext } = require("node:vm");
const v8 = require("node:v8");

const MAX_LOG_ENTRIES = 200;
const BLOCKED_HOST_SUBSTRINGS = [
  "169.254.169.254",
  "fd00:ec2::254",
  "169.254.170.2",
  "metadata.google.internal",
  "metadata.azure.com",
];

function safeCloneArg(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    try {
      return String(value);
    } catch (_e) {
      return "[unserializable]";
    }
  }
}

function run(input) {
  const { code, timeoutMs } = input;
  const logs = [];

  function capture(level) {
    return function capturedLogger() {
      if (logs.length >= MAX_LOG_ENTRIES) {
        return;
      }
      const args = new Array(arguments.length);
      for (let i = 0; i < arguments.length; i++) {
        args[i] = safeCloneArg(arguments[i]);
      }
      logs.push({ level: level, args: args });
    };
  }

  const capturedConsole = {
    log: capture("log"),
    warn: capture("warn"),
    error: capture("error"),
  };

  function extractUrl(resource) {
    if (typeof resource === "string") {
      return resource;
    }
    if (resource && typeof resource.url === "string") {
      return resource.url;
    }
    try {
      return String(resource);
    } catch (_) {
      return "";
    }
  }

  function sandboxedFetch(resource, init) {
    const url = extractUrl(resource);
    for (const blocked of BLOCKED_HOST_SUBSTRINGS) {
      if (url.indexOf(blocked) !== -1) {
        return Promise.reject(
          new Error("Fetch to metadata endpoint is blocked: " + blocked)
        );
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(function onTimeout() {
      controller.abort();
    }, timeoutMs);

    const callerSignal = init && init.signal ? init.signal : undefined;
    if (callerSignal && callerSignal.aborted) {
      controller.abort();
    } else if (callerSignal) {
      callerSignal.addEventListener(
        "abort",
        function onCallerAbort() {
          controller.abort();
        },
        { once: true }
      );
    }

    const nextInit = Object.assign({}, init, { signal: controller.signal });
    return fetch(resource, nextInit).finally(function clearTimer() {
      clearTimeout(timer);
    });
  }

  const sandbox = createContext({
    console: capturedConsole,
    fetch: sandboxedFetch,

    BigInt: BigInt, JSON: JSON, Math: Math, Date: Date, Array: Array,
    Object: Object, String: String, Number: Number, Boolean: Boolean,
    RegExp: RegExp, Symbol: Symbol,
    Map: Map, Set: Set, WeakMap: WeakMap, WeakSet: WeakSet, Promise: Promise,

    Error: Error, TypeError: TypeError, RangeError: RangeError,
    SyntaxError: SyntaxError, ReferenceError: ReferenceError, URIError: URIError,

    parseInt: parseInt, parseFloat: parseFloat,
    isNaN: isNaN, isFinite: isFinite, Infinity: Infinity, NaN: NaN,

    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    encodeURI: encodeURI, decodeURI: decodeURI,
    atob: atob, btoa: btoa,
    TextEncoder: TextEncoder, TextDecoder: TextDecoder,

    ArrayBuffer: ArrayBuffer, DataView: DataView,
    Uint8Array: Uint8Array, Uint16Array: Uint16Array, Uint32Array: Uint32Array,
    Int8Array: Int8Array, Int16Array: Int16Array, Int32Array: Int32Array,
    Float32Array: Float32Array, Float64Array: Float64Array,
    BigInt64Array: BigInt64Array, BigUint64Array: BigUint64Array,

    URL: URL, URLSearchParams: URLSearchParams, Headers: Headers,
    Request: Request, Response: Response,
    AbortController: AbortController, AbortSignal: AbortSignal,

    structuredClone: structuredClone, Intl: Intl,
    crypto: { randomUUID: crypto.randomUUID.bind(crypto) },

    SharedArrayBuffer: undefined,
  });

  const wrappedCode = "(async () => {\\n" + code + "\\n})()";

  const userPromise = runInContext(wrappedCode, sandbox, {
    timeout: timeoutMs,
    filename: "user-code.js",
  }).then(
    function onResult(result) {
      return { ok: true, result: result, logs: logs };
    },
    function onError(err) {
      return {
        ok: false,
        errorMessage:
          err && err.message ? String(err.message) : String(err),
        errorStack: err && err.stack ? String(err.stack) : undefined,
        logs: logs,
      };
    }
  );

  let timeoutTimer;
  const timeoutPromise = new Promise(function onTimeoutRace(resolveRace) {
    timeoutTimer = setTimeout(function onTimeoutFire() {
      resolveRace({
        ok: false,
        errorMessage:
          "Script execution timed out after " + String(timeoutMs) + " ms",
        logs: logs,
      });
    }, timeoutMs);
  });
  const settledUserPromise = userPromise.finally(function clearTimer() {
    clearTimeout(timeoutTimer);
  });
  return Promise.race([settledUserPromise, timeoutPromise]);
}

function writeResult(message) {
  let payload;
  try {
    payload = v8.serialize(message).toString("base64");
  } catch (cloneErr) {
    payload = v8
      .serialize({
        ok: false,
        errorMessage:
          "Result is not serializable: " +
          (cloneErr && cloneErr.message
            ? cloneErr.message
            : String(cloneErr)),
        errorStack: undefined,
        logs: [],
      })
      .toString("base64");
  }
  process.stdout.write("\\x01RESULT\\x02" + payload + "\\n");
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function onData(chunk) {
  stdinBuf += chunk;
});
process.stdin.on("end", async function onEnd() {
  let input;
  try {
    input = JSON.parse(stdinBuf);
  } catch (e) {
    writeResult({
      ok: false,
      errorMessage: "Bad input to sandbox: " + (e && e.message ? e.message : String(e)),
      logs: [],
    });
    return;
  }
  try {
    const outcome = await run(input);
    writeResult(outcome);
  } catch (err) {
    writeResult({
      ok: false,
      errorMessage: err && err.message ? String(err.message) : String(err),
      errorStack: err && err.stack ? String(err.stack) : undefined,
      logs: [],
    });
  }
});
`;

const RESULT_SENTINEL = "\u0001RESULT\u0002";

type ChildOutcome =
  | { ok: true; result: unknown; logs: LogEntry[] }
  | {
      ok: false;
      errorMessage: string;
      errorStack?: string;
      logs: LogEntry[];
    };

function parseChildOutput(stdout: string): ChildOutcome {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx === -1) {
    return {
      ok: false,
      errorMessage: "Sandbox produced no result",
      logs: [],
    };
  }
  const newlineIdx = stdout.indexOf("\n", idx);
  const end = newlineIdx === -1 ? stdout.length : newlineIdx;
  const base64 = stdout.slice(idx + RESULT_SENTINEL.length, end).trim();
  try {
    return deserialize(Buffer.from(base64, "base64")) as ChildOutcome;
  } catch (_err) {
    return {
      ok: false,
      errorMessage: "Sandbox produced malformed result",
      logs: [],
    };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single cohesive spawner with timeout + stream aggregation + graceful teardown
async function runInChild(
  code: string,
  timeoutMs: number
): Promise<ChildOutcome> {
  return await new Promise<ChildOutcome>((resolve) => {
    const child = spawn(process.execPath, ["-e", CHILD_SOURCE], {
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    function finish(outcome: ChildOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch (_err) {
          // ignore; child may already have exited
        }
      }
      resolve(outcome);
    }

    const killTimer = setTimeout(() => {
      finish({ ok: false, errorMessage: "WALL_CLOCK_TIMEOUT", logs: [] });
    }, timeoutMs + 1000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err: Error) => {
      finish({
        ok: false,
        errorMessage: err.message || String(err),
        errorStack: err.stack,
        logs: [],
      });
    });

    child.on("close", (exitCode: number | null) => {
      const parsed = parseChildOutput(stdout);
      if (parsed.ok || exitCode === 0) {
        finish(parsed);
        return;
      }
      finish({
        ok: false,
        errorMessage:
          parsed.errorMessage !== "Sandbox produced no result"
            ? parsed.errorMessage
            : `Sandbox process exited with code ${String(exitCode)}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
        logs: [],
      });
    });

    try {
      child.stdin.write(JSON.stringify({ code, timeoutMs }));
      child.stdin.end();
    } catch (err) {
      finish({
        ok: false,
        errorMessage: `Failed to send code to sandbox: ${err instanceof Error ? err.message : String(err)}`,
        logs: [],
      });
    }
  });
}

/**
 * Pre-flight input validation shared by both backends. Returns a failure
 * RunCodeResult if the input is unrunnable, otherwise null — callers branch
 * on the return value.
 */
function validateInput(input: RunCodeCoreInput): RunCodeResult | null {
  const { code } = input;
  if (!code || code.trim() === "") {
    return { success: false, error: "No code provided", logs: [] };
  }
  const unresolvedTemplates = stripStringLiterals(code).match(
    UNRESOLVED_TEMPLATE_REGEX,
  );
  if (unresolvedTemplates) {
    const unique = [...new Set(unresolvedTemplates)];
    return {
      success: false,
      error: `Unresolved template variables: ${unique.join(", ")}. Make sure upstream nodes have executed and their outputs are available.`,
      logs: [],
    };
  }
  return null;
}

/**
 * In-pod child_process runner preserved verbatim from PR #953. When
 * SANDBOX_BACKEND is "local" (default) or unset, the main app evaluates user
 * code via this runner — a spawned Node process with a scrubbed env and
 * node:vm.runInContext inside a single-use context.
 */
async function runLocal(
  input: RunCodeCoreInput,
  timeoutSeconds: number,
): Promise<RunCodeResult> {
  const timeoutMs = timeoutSeconds * 1000;
  const outcome = await runInChild(input.code, timeoutMs);

  if (outcome.ok) {
    return { success: true, result: outcome.result, logs: outcome.logs };
  }

  const isTimeout =
    outcome.errorMessage.includes("Script execution timed out") ||
    outcome.errorMessage === "WALL_CLOCK_TIMEOUT";

  const errorMessage = isTimeout
    ? `Code execution timed out after ${String(timeoutSeconds)} second${timeoutSeconds === 1 ? "" : "s"}`
    : `Code execution failed: ${outcome.errorMessage}`;

  logUserError(
    ErrorCategory.VALIDATION,
    "[Code] Execution error:",
    new Error(outcome.errorMessage),
    {
      plugin_name: "code",
      action_name: "run-code",
    },
  );

  const line = extractLineNumber(outcome.errorStack);

  return {
    success: false,
    error: errorMessage,
    logs: outcome.logs,
    ...(line !== undefined ? { line } : {}),
  };
}

/**
 * Normalize a runRemote() RunCodeResult to match the error-message shape
 * runLocal emits. The sandbox-client translator ferries ChildOutcome
 * error text through unchanged; the main-app contract wants "Code
 * execution failed: ..." for general errors and "Code execution timed
 * out after N second(s)" for timeouts so downstream consumers (UI,
 * alerting) see identical copy across backends.
 */
function normalizeRemoteError(
  outcome: RunCodeResult,
  timeoutSeconds: number,
): RunCodeResult {
  if (outcome.success) {
    return outcome;
  }
  const raw = outcome.error;
  const isTimeout =
    raw.includes("Script execution timed out") ||
    raw === "WALL_CLOCK_TIMEOUT" ||
    raw.includes("timed out after");
  const rewritten = isTimeout
    ? `Code execution timed out after ${String(timeoutSeconds)} second${timeoutSeconds === 1 ? "" : "s"}`
    : raw.startsWith("Code execution failed:") ||
        raw.startsWith("sandbox client error:") ||
        raw.startsWith("No code provided") ||
        raw.startsWith("Unresolved template variables:")
      ? raw
      : `Code execution failed: ${raw}`;
  return { ...outcome, error: rewritten };
}

/**
 * Backend dispatcher. SANDBOX_BACKEND is read once at module init; when
 * "remote" we delegate to lib/sandbox-client.ts, otherwise runLocal handles
 * the invocation via the in-pod child_process path.
 */
async function stepHandler(input: RunCodeCoreInput): Promise<RunCodeResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return validationError;
  }
  const rawTimeout = input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const clampedSeconds = Math.min(
    Math.max(1, rawTimeout),
    MAX_TIMEOUT_SECONDS,
  );
  if (SANDBOX_BACKEND === "remote") {
    const outcome = await runRemote({
      code: input.code,
      timeoutMs: clampedSeconds * 1000,
    });
    return normalizeRemoteError(outcome, clampedSeconds);
  }
  return runLocal(input, clampedSeconds);
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function runCodeStep(input: RunCodeInput): Promise<RunCodeResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "code",
      actionName: "run-code",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input)),
  );
}
runCodeStep.maxRetries = 0;

export const _integrationType = "code";
