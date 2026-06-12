import { spawn } from "node:child_process";
import {
  SANDBOX_CHILD_SOURCE as CHILD_SOURCE,
  createSandboxResultReader,
  decodeSandboxResult,
  SANDBOX_RESULT_FD,
  type SandboxResultReader,
} from "../../lib/sandbox/child-source.js";

type LogEntry = {
  level: "log" | "warn" | "error";
  args: unknown[];
};

export type ChildOutcome =
  | { ok: true; result: unknown; logs: LogEntry[] }
  | {
      ok: false;
      errorMessage: string;
      errorStack?: string;
      logs: LogEntry[];
    };

/**
 * Environment variables forwarded to the sandbox child process. Everything
 * else is dropped so that a sandbox escape cannot read pod secrets from
 * process.env nor from /proc/self/environ (the child is a fresh OS process
 * started with execve, so its kernel-level environ is exactly this set).
 * Keep minimal: only what Node itself needs to start and make TLS calls.
 * Do NOT add application secrets here.
 */
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

function isChildOutcome(value: unknown): value is ChildOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

function outcomeFromReader(reader: SandboxResultReader): ChildOutcome {
  if (reader.error) {
    return { ok: false, errorMessage: reader.error, logs: [] };
  }
  if (!reader.frame) {
    return { ok: false, errorMessage: "Sandbox produced no result", logs: [] };
  }
  try {
    // Safe by construction: JSON.parse + tag rebuild, never v8.deserialize on
    // child-produced bytes (F-010). Validate the envelope shape since the
    // child is untrusted.
    const decoded = decodeSandboxResult(reader.frame.toString("utf8"));
    if (!isChildOutcome(decoded)) {
      return {
        ok: false,
        errorMessage: "Sandbox produced malformed result",
        logs: [],
      };
    }
    return decoded;
  } catch (_err) {
    return {
      ok: false,
      errorMessage: "Sandbox produced malformed result",
      logs: [],
    };
  }
}

/**
 * Spawn a child Node process with a scrubbed env, run the user code inside
 * it, and return the child's outcome. Kills the child on timeout or when
 * the caller's AbortSignal fires.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single cohesive spawner with timeout + stream aggregation + graceful teardown + signal wiring
async function runInChild(
  code: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ChildOutcome> {
  return await new Promise<ChildOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, errorMessage: "ABORTED", logs: [] });
      return;
    }

    // fd 3 is the dedicated result channel (F-010). stdout/stderr stay
    // user-facing diagnostics and are never deserialized.
    const child = spawn(process.execPath, ["-e", CHILD_SOURCE], {
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });

    const resultReader = createSandboxResultReader();
    let stderr = "";
    let settled = false;

    const onAbort = (): void => {
      finish({ ok: false, errorMessage: "ABORTED", logs: [] });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(outcome: ChildOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
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

    // Drain stdout so a sandbox escape that writes there cannot fill the pipe
    // and block the child; the bytes are intentionally discarded (never a
    // result source).
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const resultStream = child.stdio[SANDBOX_RESULT_FD];
    if (resultStream && "on" in resultStream) {
      resultStream.on("data", (chunk: Buffer) => {
        resultReader.push(chunk);
        if (resultReader.done) {
          // First complete frame wins; resolve now and reap the child even if
          // escaped code kept the event loop alive past the result.
          finish(outcomeFromReader(resultReader));
        }
      });
      resultStream.on("error", () => {
        // Pipe teardown races process exit; the close handler maps the outcome.
      });
    }

    child.on("error", (err: Error) => {
      finish({
        ok: false,
        errorMessage: err.message || String(err),
        errorStack: err.stack,
        logs: [],
      });
    });

    child.on("close", (exitCode: number | null) => {
      const parsed = outcomeFromReader(resultReader);
      if (parsed.ok || exitCode === 0) {
        finish(parsed);
        return;
      }
      // Non-zero exit with no result frame; surface stderr as a hint.
      finish({
        ok: false,
        errorMessage:
          parsed.errorMessage === "Sandbox produced no result"
            ? `Sandbox process exited with code ${String(exitCode)}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`
            : parsed.errorMessage,
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
 * Public API: run `code` in a fresh scrubbed child process with a wall-clock
 * timeout of `timeoutMs` milliseconds. Resolves with a ChildOutcome describing
 * either the user result (v8-deserialized) or a structured error.
 */
export async function runCode(input: {
  code: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ChildOutcome> {
  return runInChild(input.code, input.timeoutMs, input.signal);
}
