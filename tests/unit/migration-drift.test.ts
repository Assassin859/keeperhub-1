import { describe, expect, it } from "vitest";
import { isMigrationDriftOutput } from "@/scripts/lib/migration-drift";

describe("isMigrationDriftOutput", () => {
  it("returns true for journal duplicate key collisions", () => {
    expect(
      isMigrationDriftOutput(
        "duplicate key value violates unique constraint on drizzle.__drizzle_migrations"
      )
    ).toBe(true);
  });

  it("returns true when journal table and already exists appear together", () => {
    expect(
      isMigrationDriftOutput(
        "error in drizzle.__drizzle_migrations: already exists"
      )
    ).toBe(true);
  });

  it("returns false for relation already exists without journal context", () => {
    expect(
      isMigrationDriftOutput('ERROR: relation "users" already exists')
    ).toBe(false);
  });

  it("returns false for connection errors", () => {
    expect(isMigrationDriftOutput("connection refused")).toBe(false);
  });

  it("returns false for authentication failures", () => {
    expect(isMigrationDriftOutput("password authentication failed")).toBe(
      false
    );
  });

  it("returns false for syntax errors", () => {
    expect(isMigrationDriftOutput("syntax error at or near")).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(isMigrationDriftOutput("")).toBe(false);
    expect(isMigrationDriftOutput("   ")).toBe(false);
  });
});
