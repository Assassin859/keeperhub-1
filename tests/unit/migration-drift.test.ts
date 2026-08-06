import { describe, expect, it } from "vitest";
import {
  getExpectedJournalCount,
  hasPublicSchemaCollisionOutput,
  isMissingRelationError,
  type PostgresClient,
  queryJournalDriftState,
  shouldRecoverAfterMigrateFailure,
} from "@/scripts/lib/migration-drift";

const DB_PUSH_MIGRATE_FAILURE = `DrizzleQueryError: Failed query: CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL
);
params:
    at migrate (/node_modules/drizzle-orm/pg-core/dialect.ts:123:11)
PostgresError: relation "users" already exists`;

const JOURNAL_INDEX_FAILURE = `DrizzleQueryError: Failed query: CREATE INDEX "idx_j" ON "drizzle"."__drizzle_migrations" ("id");
params:
PostgresError: relation "idx_j" already exists`;

function createMockClient(options: {
  usersExists: boolean;
  journalCount?: number;
  journalError?: unknown;
}): PostgresClient {
  const end = async (): Promise<void> => undefined;
  const client = async (
    strings: TemplateStringsArray
  ): Promise<Array<{ exists?: boolean; c?: number }>> => {
    const query = strings.join("");
    if (query.includes("information_schema.tables")) {
      return [{ exists: options.usersExists }];
    }
    if (query.includes("COUNT(*)") && query.includes("__drizzle_migrations")) {
      if (options.journalError !== undefined) {
        throw options.journalError;
      }
      return [{ c: options.journalCount ?? 0 }];
    }
    return [];
  };
  return Object.assign(client, { end }) as unknown as PostgresClient;
}

describe("hasPublicSchemaCollisionOutput", () => {
  it("returns true for real db:push migrate failure output", () => {
    expect(hasPublicSchemaCollisionOutput(DB_PUSH_MIGRATE_FAILURE)).toBe(true);
  });

  it("returns false for drizzle schema index collisions", () => {
    expect(hasPublicSchemaCollisionOutput(JOURNAL_INDEX_FAILURE)).toBe(false);
  });

  it("returns false for syntax errors", () => {
    expect(hasPublicSchemaCollisionOutput("syntax error at or near")).toBe(
      false
    );
  });

  it("returns false for connection errors", () => {
    expect(hasPublicSchemaCollisionOutput("connection refused")).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(hasPublicSchemaCollisionOutput("")).toBe(false);
    expect(hasPublicSchemaCollisionOutput("   ")).toBe(false);
  });
});

describe("isMissingRelationError", () => {
  it("matches Postgres undefined_table code", () => {
    expect(isMissingRelationError({ code: "42P01" })).toBe(true);
  });

  it("matches relation does not exist messages", () => {
    expect(
      isMissingRelationError({
        message: 'relation "drizzle.__drizzle_migrations" does not exist',
      })
    ).toBe(true);
  });

  it("does not match permission errors", () => {
    expect(
      isMissingRelationError({
        code: "42501",
        message: "permission denied for table __drizzle_migrations",
      })
    ).toBe(false);
  });
});

describe("queryJournalDriftState", () => {
  it("treats a missing journal table as count 0", async () => {
    const client = createMockClient({
      usersExists: true,
      journalError: {
        code: "42P01",
        message: 'relation "drizzle.__drizzle_migrations" does not exist',
      },
    });

    const state = await queryJournalDriftState(client);
    expect(state.journalCount).toBe(0);
    expect(state.usersExists).toBe(true);
  });

  it("rethrows permission errors instead of treating the journal as empty", async () => {
    const client = createMockClient({
      usersExists: true,
      journalError: {
        code: "42501",
        message: "permission denied for table __drizzle_migrations",
      },
    });

    await expect(queryJournalDriftState(client)).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("shouldRecoverAfterMigrateFailure", () => {
  it("recovers when schema is ahead of an empty journal and output shows public collision", async () => {
    const client = createMockClient({
      usersExists: true,
      journalCount: 0,
    });

    const result = await shouldRecoverAfterMigrateFailure(
      client,
      DB_PUSH_MIGRATE_FAILURE
    );

    expect(result).toEqual({ recover: true, throughTag: null });
  });

  it("recovers without a --through bound when the journal is partial", async () => {
    const client = createMockClient({
      usersExists: true,
      journalCount: 1,
    });

    const result = await shouldRecoverAfterMigrateFailure(
      client,
      DB_PUSH_MIGRATE_FAILURE
    );

    expect(result).toEqual({ recover: true, throughTag: null });
  });

  it("does not recover when the journal is fully populated", async () => {
    const client = createMockClient({
      usersExists: true,
      journalCount: getExpectedJournalCount(),
    });

    const result = await shouldRecoverAfterMigrateFailure(
      client,
      DB_PUSH_MIGRATE_FAILURE
    );

    expect(result).toEqual({ recover: false, throughTag: null });
  });

  it("does not recover for drizzle schema index collisions even when journal lags", async () => {
    const client = createMockClient({
      usersExists: true,
      journalCount: 59,
    });

    const result = await shouldRecoverAfterMigrateFailure(
      client,
      JOURNAL_INDEX_FAILURE
    );

    expect(result).toEqual({ recover: false, throughTag: null });
  });

  it("does not recover for non-collision migrate failures", async () => {
    const client = createMockClient({
      usersExists: true,
      journalCount: 0,
    });

    const result = await shouldRecoverAfterMigrateFailure(
      client,
      "syntax error at or near"
    );

    expect(result).toEqual({ recover: false, throughTag: null });
  });
});

describe("getExpectedJournalCount", () => {
  it("reads a non-zero entry count from the journal file", () => {
    expect(getExpectedJournalCount()).toBeGreaterThan(0);
  });
});
