import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const postgresMock = vi.hoisted(() => vi.fn());
const endMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("postgres", () => ({
  default: postgresMock,
}));

import {
  BACKFILL_COMMAND,
  MIGRATE_COMMAND,
  runMigrateWithRecovery,
} from "@/scripts/lib/migration-drift";

const DB_PUSH_MIGRATE_FAILURE = `DrizzleQueryError: Failed query: CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL
);
params:
PostgresError: relation "users" already exists`;

const BACKFILL_SCRIPT_SUFFIX = "backfill-drizzle-migrations.ts";

function hashFirstJournalMigration(): string {
  const journalPath = path.join(
    process.cwd(),
    "drizzle",
    "meta",
    "_journal.json"
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const tag = journal.entries[0]?.tag;
  if (!tag) {
    throw new Error("expected at least one journal entry");
  }
  const sqlPath = path.join(process.cwd(), "drizzle", `${tag}.sql`);
  const content = fs.readFileSync(sqlPath, "utf8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

function mockPostgresClient(options: {
  usersExists: boolean;
  journalCount: number;
  hashes?: string[];
}): void {
  endMock.mockResolvedValue(undefined);
  const client = async (
    strings: TemplateStringsArray
  ): Promise<Array<{ exists?: boolean; c?: number; hash?: string }>> => {
    const query = strings.join("");
    if (query.includes("information_schema.tables")) {
      return [{ exists: options.usersExists }];
    }
    if (query.includes("COUNT(*)") && query.includes("__drizzle_migrations")) {
      return [{ c: options.journalCount }];
    }
    if (query.includes("SELECT hash FROM drizzle.__drizzle_migrations")) {
      return (options.hashes ?? []).map((hash) => ({ hash }));
    }
    return [];
  };
  postgresMock.mockReturnValue(Object.assign(client, { end: endMock }));
}

function mockSpawnSequence(
  responses: Array<{
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  }>
): void {
  let call = 0;
  spawnSyncMock.mockImplementation((_cmd, _args: string[]) => {
    const response = responses[call] ?? {
      status: 1,
      stderr: "unexpected call",
    };
    call += 1;
    return {
      status: response.status,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      error: response.error,
    };
  });
}

describe("runMigrateWithRecovery", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    postgresMock.mockReset();
    endMock.mockReset();
  });

  it("returns ok when the first migrate succeeds", async () => {
    mockSpawnSequence([{ status: 0, stdout: "applied migrations" }]);

    const result = await runMigrateWithRecovery(
      "postgresql://postgres:postgres@localhost:5433/keeperhub",
      process.env,
      () => undefined
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("applied migrations");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "pnpm",
      ["db:migrate"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it("runs backfill and retries when db:push drift is detected from DB state", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 0 });
    mockSpawnSequence([
      { status: 1, stderr: DB_PUSH_MIGRATE_FAILURE },
      { status: 0, stdout: "backfilled journal" },
      { status: 0, stdout: "retry migrate ok" },
    ]);

    const logs: string[] = [];
    const result = await runMigrateWithRecovery(
      "postgresql://postgres:postgres@localhost:5433/keeperhub",
      process.env,
      (message) => logs.push(message)
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("retry migrate ok");
    expect(logs).toContain(
      "dev-bootstrap: migration drift detected (schema ahead of journal)"
    );
    expect(logs).toContain(
      "dev-bootstrap: journal backfilled; retrying db:migrate once"
    );
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      "pnpm",
      ["db:migrate"],
      expect.any(Object)
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "pnpm",
      ["tsx", expect.stringContaining(BACKFILL_SCRIPT_SUFFIX)],
      expect.any(Object)
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      3,
      "pnpm",
      ["db:migrate"],
      expect.any(Object)
    );
    expect(endMock).toHaveBeenCalled();
  });

  it("passes --through when the journal is partially populated", async () => {
    const firstHash = hashFirstJournalMigration();
    mockPostgresClient({
      usersExists: true,
      journalCount: 1,
      hashes: [firstHash],
    });
    mockSpawnSequence([
      { status: 1, stderr: DB_PUSH_MIGRATE_FAILURE },
      { status: 0, stdout: "backfilled journal" },
      { status: 0, stdout: "retry migrate ok" },
    ]);

    await runMigrateWithRecovery(
      "postgresql://postgres:postgres@localhost:5433/keeperhub",
      process.env,
      () => undefined
    );

    const backfillCall = spawnSyncMock.mock.calls[1];
    expect(backfillCall?.[1]).toEqual(expect.arrayContaining(["--through"]));
  });

  it("preserves first migrate output when retry fails for another reason", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 0 });
    mockSpawnSequence([
      { status: 1, stderr: DB_PUSH_MIGRATE_FAILURE },
      { status: 0, stdout: "backfilled journal" },
      { status: 2, stderr: "connection refused" },
    ]);

    const result = await runMigrateWithRecovery(
      "postgresql://postgres:postgres@localhost:5433/keeperhub",
      process.env,
      () => undefined
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('relation "users" already exists');
    expect(result.output).toContain("connection refused");
    expect(result.status).toBe(2);
    expect(result.failedCommand).toBe(MIGRATE_COMMAND);
  });

  it("does not run backfill for non-drift migrate failures", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 0 });
    mockSpawnSequence([{ status: 1, stderr: "syntax error at or near" }]);

    const result = await runMigrateWithRecovery(
      "postgresql://postgres:postgres@localhost:5433/keeperhub",
      process.env,
      () => undefined
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("syntax error");
    expect(result.failedCommand).toBe(MIGRATE_COMMAND);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("reports backfill command failure instead of migrate", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 0 });
    mockSpawnSequence([
      { status: 1, stderr: DB_PUSH_MIGRATE_FAILURE },
      { status: 3, stderr: "backfill failed" },
    ]);

    const result = await runMigrateWithRecovery(
      "postgresql://postgres:postgres@localhost:5433/keeperhub",
      process.env,
      () => undefined
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('relation "users" already exists');
    expect(result.output).toContain("backfill failed");
    expect(result.status).toBe(3);
    expect(result.failedCommand).toBe(BACKFILL_COMMAND);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces spawn errors with the failing command", async () => {
    mockPostgresClient({ usersExists: true, journalCount: 0 });
    mockSpawnSequence([
      { status: 1, stderr: DB_PUSH_MIGRATE_FAILURE },
      {
        status: null,
        error: new Error("spawnSync pnpm ENOENT"),
      },
    ]);

    const result = await runMigrateWithRecovery(
      "postgresql://postgres:postgres@localhost:5433/keeperhub",
      process.env,
      () => undefined
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("ENOENT");
    expect(result.failedCommand).toBe(BACKFILL_COMMAND);
  });
});
