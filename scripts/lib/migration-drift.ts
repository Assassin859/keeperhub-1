import { spawnSync } from "node:child_process";
import * as path from "node:path";

const JOURNAL_COLLISION = /__drizzle_migrations/;
const DUPLICATE_OR_EXISTS = /(already exists|duplicate key)/i;

const BACKFILL_SCRIPT = path.join(
  __dirname,
  "..",
  "backfill-drizzle-migrations.ts"
);

export type CommandResult = {
  ok: boolean;
  output: string;
  status: number | null;
};

export type MigrateRecoveryResult = {
  ok: boolean;
  output: string;
  firstOutput: string;
  status: number | null;
};

function combineOutput(
  stdout: string | Buffer | null | undefined,
  stderr: string | Buffer | null | undefined
): string {
  const parts = [stdout, stderr]
    .filter((value): value is string | Buffer => value != null && value !== "")
    .map((value) => (typeof value === "string" ? value : value.toString()));
  return parts.join("\n");
}

export function isMigrationDriftOutput(output: string): boolean {
  const text = output.trim();
  if (text.length === 0) {
    return false;
  }

  return JOURNAL_COLLISION.test(text) && DUPLICATE_OR_EXISTS.test(text);
}

export function runBackfillScript(
  env: NodeJS.ProcessEnv = process.env
): CommandResult {
  const result = spawnSync("pnpm", ["tsx", BACKFILL_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    encoding: "utf8",
  });

  const output = combineOutput(result.stdout, result.stderr);
  return {
    ok: result.status === 0,
    output,
    status: result.status,
  };
}

export function runDbMigrate(
  env: NodeJS.ProcessEnv = process.env
): CommandResult {
  const result = spawnSync("pnpm", ["db:migrate"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    encoding: "utf8",
  });

  const output = combineOutput(result.stdout, result.stderr);
  return {
    ok: result.status === 0,
    output,
    status: result.status,
  };
}

export function runMigrateWithRecovery(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = (message) => console.log(message)
): MigrateRecoveryResult {
  const first = runDbMigrate(env);
  if (first.ok) {
    return {
      ok: true,
      output: first.output,
      firstOutput: first.output,
      status: first.status,
    };
  }

  const firstOutput = first.output;
  if (!isMigrationDriftOutput(firstOutput)) {
    return {
      ok: false,
      output: firstOutput,
      firstOutput,
      status: first.status,
    };
  }

  log(
    "dev-bootstrap: migration drift detected (schema ahead of journal)"
  );
  log("dev-bootstrap: running backfill-drizzle-migrations.ts...");

  const backfill = runBackfillScript(env);
  if (!backfill.ok) {
    const output = [firstOutput, backfill.output].filter(Boolean).join("\n");
    return {
      ok: false,
      output,
      firstOutput,
      status: backfill.status,
    };
  }

  log("dev-bootstrap: journal backfilled; retrying db:migrate once");

  const retry = runDbMigrate(env);
  if (retry.ok) {
    return {
      ok: true,
      output: retry.output,
      firstOutput,
      status: retry.status,
    };
  }

  const output = [firstOutput, retry.output].filter(Boolean).join("\n");
  return {
    ok: false,
    output,
    firstOutput,
    status: retry.status,
  };
}
