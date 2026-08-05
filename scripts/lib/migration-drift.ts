import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";

import postgres from "postgres";

const ALREADY_EXISTS = /(already exists|duplicate key)/i;
const PUBLIC_SCHEMA_COLLISION =
  /(?:Failed query:\s*CREATE TABLE|relation "[^"]+" already exists)/i;

const BACKFILL_SCRIPT = path.join(
  __dirname,
  "..",
  "backfill-drizzle-migrations.ts"
);
const JOURNAL_PATH = path.join(
  __dirname,
  "..",
  "..",
  "drizzle",
  "meta",
  "_journal.json"
);
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "drizzle");

export const MIGRATE_COMMAND = "pnpm db:migrate";
export const BACKFILL_COMMAND =
  "pnpm tsx scripts/backfill-drizzle-migrations.ts";

const SPAWN_MAX_BUFFER = 10 * 1024 * 1024;

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

export type PostgresClient = ReturnType<typeof postgres>;

export type CommandResult = {
  ok: boolean;
  output: string;
  status: number | null;
  failedCommand?: string;
};

export type MigrateRecoveryResult = {
  ok: boolean;
  output: string;
  status: number | null;
  failedCommand?: string;
};

export type JournalDriftState = {
  usersExists: boolean;
  journalCount: number;
  expectedCount: number;
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

function readJournalEntries(): JournalEntry[] {
  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries.slice().sort((a, b) => a.idx - b.idx);
}

function hashMigrationFile(tag: string): string | null {
  const sqlPath = path.join(MIGRATIONS_DIR, `${tag}.sql`);
  if (!fs.existsSync(sqlPath)) {
    return null;
  }
  const content = fs.readFileSync(sqlPath, "utf8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function getExpectedJournalCount(): number {
  return readJournalEntries().length;
}

export function computeThroughTagFromHashes(
  existingHashes: Set<string>
): string | null {
  if (existingHashes.size === 0) {
    return null;
  }

  let highestPrefix: string | null = null;
  for (const entry of readJournalEntries()) {
    const hash = hashMigrationFile(entry.tag);
    if (hash && existingHashes.has(hash)) {
      const prefix = entry.tag.split("_")[0];
      if (highestPrefix === null || prefix > highestPrefix) {
        highestPrefix = prefix;
      }
    }
  }
  return highestPrefix;
}

export async function queryJournalDriftState(
  client: PostgresClient
): Promise<JournalDriftState> {
  const usersExists = await client<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    ) AS exists
  `;

  const journalCount = await client<{ c: number }[]>`
    SELECT COALESCE(
      (SELECT COUNT(*)::int FROM drizzle.__drizzle_migrations),
      0
    ) AS c
  `.catch(() => [{ c: 0 }]);

  return {
    usersExists: usersExists[0]?.exists ?? false,
    journalCount: journalCount[0]?.c ?? 0,
    expectedCount: getExpectedJournalCount(),
  };
}

export function hasPublicSchemaCollisionOutput(output: string): boolean {
  const text = output.trim();
  if (text.length === 0 || !ALREADY_EXISTS.test(text)) {
    return false;
  }

  // Failures on drizzle-schema objects (journal table indexes, etc.) are not
  // db:push drift even when the output also contains "already exists".
  if (/Failed query:[^;\n]*"drizzle"/i.test(text)) {
    return false;
  }
  if (/CREATE (?:TABLE|INDEX)[^;\n]*"drizzle"/i.test(text)) {
    return false;
  }

  return PUBLIC_SCHEMA_COLLISION.test(text);
}

export async function shouldRecoverAfterMigrateFailure(
  client: PostgresClient,
  output: string
): Promise<{ recover: boolean; throughTag: string | null }> {
  const state = await queryJournalDriftState(client);

  if (!state.usersExists || state.journalCount >= state.expectedCount) {
    return { recover: false, throughTag: null };
  }

  if (!hasPublicSchemaCollisionOutput(output)) {
    return { recover: false, throughTag: null };
  }

  if (state.journalCount === 0) {
    return { recover: true, throughTag: null };
  }

  const existing = await client<{ hash: string }[]>`
    SELECT hash FROM drizzle.__drizzle_migrations
  `;
  const existingHashes = new Set(existing.map((row) => row.hash));
  const throughTag = computeThroughTagFromHashes(existingHashes);

  return { recover: true, throughTag };
}

function spawnPnpm(
  commandLabel: string,
  args: string[],
  env: NodeJS.ProcessEnv
): CommandResult {
  const result = spawnSync("pnpm", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER,
  });

  if (result.error) {
    return {
      ok: false,
      output: result.error.message,
      status: result.status,
      failedCommand: commandLabel,
    };
  }

  const output = combineOutput(result.stdout, result.stderr);
  if (result.status === 0) {
    return {
      ok: true,
      output,
      status: result.status,
    };
  }

  return {
    ok: false,
    output,
    status: result.status,
    failedCommand: commandLabel,
  };
}

export function runBackfillScript(
  options: {
    through?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {}
): CommandResult {
  const env = options.env ?? process.env;
  const args = ["tsx", BACKFILL_SCRIPT];
  if (options.through) {
    args.push("--through", options.through);
  }

  return spawnPnpm(BACKFILL_COMMAND, args, env);
}

export function runDbMigrate(env: NodeJS.ProcessEnv = process.env): CommandResult {
  return spawnPnpm(MIGRATE_COMMAND, ["db:migrate"], env);
}

export async function runMigrateWithRecovery(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = (message) => console.log(message)
): Promise<MigrateRecoveryResult> {
  const first = runDbMigrate(env);
  if (first.ok) {
    return {
      ok: true,
      output: first.output,
      status: first.status,
    };
  }

  const firstOutput = first.output;
  const client = postgres(databaseUrl, { max: 1 });
  let recovery: { recover: boolean; throughTag: string | null };
  try {
    recovery = await shouldRecoverAfterMigrateFailure(client, firstOutput);
  } finally {
    await client.end();
  }

  if (!recovery.recover) {
    return {
      ok: false,
      output: firstOutput,
      status: first.status,
      failedCommand: MIGRATE_COMMAND,
    };
  }

  log(
    "dev-bootstrap: migration drift detected (schema ahead of journal)"
  );
  log("dev-bootstrap: running backfill-drizzle-migrations.ts...");

  const backfill = runBackfillScript({
    through: recovery.throughTag,
    env,
  });
  if (!backfill.ok) {
    const output = [firstOutput, backfill.output].filter(Boolean).join("\n");
    return {
      ok: false,
      output,
      status: backfill.status,
      failedCommand: BACKFILL_COMMAND,
    };
  }

  log("dev-bootstrap: journal backfilled; retrying db:migrate once");

  const retry = runDbMigrate(env);
  if (retry.ok) {
    return {
      ok: true,
      output: retry.output,
      status: retry.status,
    };
  }

  const output = [firstOutput, retry.output].filter(Boolean).join("\n");
  return {
    ok: false,
    output,
    status: retry.status,
    failedCommand: MIGRATE_COMMAND,
  };
}
