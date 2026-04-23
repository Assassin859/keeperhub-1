import "server-only";

import { Worker } from "node:worker_threads";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
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
 * Strip JS string literals (single, double, backtick) so that {{...}}
 * patterns inside strings are not mistaken for unresolved templates.
 * Handles escaped quotes. Does not handle nested template literal
 * expressions (${...}) but that is sufficient for this use case.
 */
const JS_STRING_LITERAL_REGEX =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function stripStringLiterals(code: string): string {
  return code.replace(JS_STRING_LITERAL_REGEX, "");
}

/**
 * Extract a user-code line number from a VM stack trace if available.
 */
function extractLineNumber(stack: string | undefined): number | undefined {
  if (!stack) {
    return undefined;
  }
  const match = stack.match(VM_LINE_REGEX);
  if (match?.[1]) {
    // Subtract 1 to account for the async IIFE wrapper line prepended to user code
    const rawLine = Number.parseInt(match[1], 10);
    return Math.max(1, rawLine - 1);
  }
  return undefined;
}

/**
 * Environment variables forwarded to the sandbox worker. Everything else is
 * dropped so that a sandbox escape cannot read pod secrets from process.env.
 * Keep this list minimal: only what Node itself needs to start and make TLS
 * calls. Do NOT add application secrets here.
 */
const WORKER_ENV_ALLOWLIST = [
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "TZ",
  "LANG",
  "LC_ALL",
] as const;

function buildWorkerEnv(): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as NodeJS.ProcessEnv;
}

/**
 * Worker script executed in an isolated thread with a scrubbed process.env.
 *
 * This is the only layer that evaluates user-supplied JavaScript. The main
 * thread never calls vm.runInContext on user code.
 *
 * The script is intentionally inlined as a string: spawning the worker via
 * `new Worker(source, { eval: true })` avoids a separate worker module file
 * that the Next.js bundler would need to emit and resolve at runtime.
 */
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { createContext, runInContext } = require("node:vm");

const MAX_LOG_ENTRIES = 200;
const logs = [];

// Hosts blocked from inside user code. This is a coarse string match, not a
// full SSRF defence -- see KEEP ticket for restoring safeFetch's blocklist
// inside the sandbox. These are the highest-value exfiltration targets.
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

function capture(level) {
  return function capturedLogger() {
    if (logs.length >= MAX_LOG_ENTRIES) {
      return;
    }
    const args = new Array(arguments.length);
    for (let i = 0; i < arguments.length; i++) {
      args[i] = safeCloneArg(arguments[i]);
    }
    logs.push({ level, args });
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
  }, workerData.timeoutMs);

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

  BigInt, JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Symbol,
  Map, Set, WeakMap, WeakSet, Promise,

  Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError,

  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,

  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  atob, btoa,
  TextEncoder, TextDecoder,

  ArrayBuffer, DataView,
  Uint8Array, Uint16Array, Uint32Array,
  Int8Array, Int16Array, Int32Array,
  Float32Array, Float64Array,
  BigInt64Array, BigUint64Array,

  URL, URLSearchParams, Headers, Request, Response,
  AbortController, AbortSignal,

  structuredClone, Intl,
  crypto: { randomUUID: crypto.randomUUID.bind(crypto) },

  SharedArrayBuffer: undefined,
});

const wrappedCode = "(async () => {\\n" + workerData.code + "\\n})()";

function send(message) {
  try {
    parentPort.postMessage(message);
  } catch (cloneErr) {
    try {
      parentPort.postMessage({
        ok: false,
        errorMessage:
          "Result is not serializable: " +
          (cloneErr && cloneErr.message ? cloneErr.message : String(cloneErr)),
        errorStack: undefined,
        logs: [],
      });
    } catch (_) {
      // Parent observes worker exit and surfaces a generic error.
    }
  }
}

(async function runUserCode() {
  try {
    const execution = runInContext(wrappedCode, sandbox, {
      timeout: workerData.timeoutMs,
      filename: "user-code.js",
    });
    const result = await execution;
    send({ ok: true, result, logs });
  } catch (err) {
    send({
      ok: false,
      errorMessage: err && err.message ? String(err.message) : String(err),
      errorStack: err && err.stack ? String(err.stack) : undefined,
      logs,
    });
  }
})();
`;

type WorkerOutcome =
  | { ok: true; result: unknown; logs: LogEntry[] }
  | {
      ok: false;
      errorMessage: string;
      errorStack?: string;
      logs: LogEntry[];
    };

/**
 * Spawn a worker with a scrubbed env, run the user code inside it, and return
 * the worker's outcome. Terminates the worker on timeout.
 */
async function runInWorker(
  code: string,
  timeoutMs: number
): Promise<WorkerOutcome> {
  return await new Promise<WorkerOutcome>((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      env: buildWorkerEnv(),
      workerData: { code, timeoutMs },
    });

    let settled = false;

    function finish(outcome: WorkerOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      worker
        .terminate()
        .catch(() => undefined)
        .finally(() => resolve(outcome));
    }

    // Hard kill: vm `timeout` only covers sync CPU time; async code (fetch,
    // Promise loops) can outlive it. Give the worker a small grace period
    // over the configured timeout, then terminate.
    const killTimer = setTimeout(() => {
      finish({
        ok: false,
        errorMessage: "WALL_CLOCK_TIMEOUT",
        logs: [],
      });
    }, timeoutMs + 1000);

    worker.once("message", (msg: WorkerOutcome) => finish(msg));

    worker.once("error", (err: Error) => {
      finish({
        ok: false,
        errorMessage: err.message || String(err),
        errorStack: err.stack,
        logs: [],
      });
    });

    worker.once("exit", (exitCode: number) => {
      if (exitCode !== 0) {
        finish({
          ok: false,
          errorMessage: `Sandbox worker exited unexpectedly (code ${String(exitCode)})`,
          logs: [],
        });
      }
    });
  });
}

/**
 * Core logic - executes user code in a sandboxed worker thread.
 *
 * Template variables (e.g. {{NodeName.field}}) are resolved by the workflow
 * engine before the code reaches this handler -- the code string already
 * contains the actual values at execution time.
 *
 * Security model: user code runs inside a `worker_threads.Worker` whose
 * process.env is restricted to WORKER_ENV_ALLOWLIST. Inside the worker we
 * still use `node:vm.runInContext`, which is NOT a cryptographic sandbox --
 * native constructors leak the host prototype chain and
 * `Error.constructor("return process")()` still reaches `process`. That reach
 * is the point: the worker's process.env is empty of secrets, so the escape
 * yields no pod credentials. Defence in depth for env-mounted secrets only.
 * Other Node surfaces inside the worker (fs, net) are still reachable on
 * escape -- the long-term fix is tracked separately (out-of-process sandbox
 * / isolated-vm).
 */
async function stepHandler(input: RunCodeCoreInput): Promise<RunCodeResult> {
  const { code } = input;

  if (!code || code.trim() === "") {
    return { success: false, error: "No code provided", logs: [] };
  }

  // Check for unresolved template variables that would cause syntax errors.
  // Strip string literals first so {{...}} inside quotes is not flagged.
  const unresolvedTemplates = stripStringLiterals(code).match(
    UNRESOLVED_TEMPLATE_REGEX
  );
  if (unresolvedTemplates) {
    const unique = [...new Set(unresolvedTemplates)];
    return {
      success: false,
      error: `Unresolved template variables: ${unique.join(", ")}. Make sure upstream nodes have executed and their outputs are available.`,
      logs: [],
    };
  }

  const rawTimeout = input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutSeconds = Math.min(Math.max(1, rawTimeout), MAX_TIMEOUT_SECONDS);
  const timeoutMs = timeoutSeconds * 1000;

  const outcome = await runInWorker(code, timeoutMs);

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
    }
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
 * Entry point - wraps with logging + metrics
 */
// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function runCodeStep(input: RunCodeInput): Promise<RunCodeResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "code",
      actionName: "run-code",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}
runCodeStep.maxRetries = 0;

export const _integrationType = "code";
