import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { runMigrateWithRecovery } from "@/scripts/lib/migration-drift";

function mockSpawnSequence(
  responses: Array<{
    status: number | null;
    stdout?: string;
    stderr?: string;
  }>
): void {
  let call = 0;
  spawnSyncMock.mockImplementation(() => {
    const response = responses[call] ?? {
      status: 1,
      stderr: "unexpected call",
    };
    call += 1;
    return {
      status: response.status,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  });
}

describe("runMigrateWithRecovery", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("returns ok when the first migrate succeeds", () => {
    mockSpawnSequence([{ status: 0, stdout: "applied migrations" }]);

    const result = runMigrateWithRecovery(process.env, () => undefined);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("applied migrations");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("runs backfill and retries when drift is detected", () => {
    mockSpawnSequence([
      {
        status: 1,
        stderr:
          "duplicate key value violates unique constraint on drizzle.__drizzle_migrations",
      },
      { status: 0, stdout: "backfilled journal" },
      { status: 0, stdout: "retry migrate ok" },
    ]);

    const logs: string[] = [];
    const result = runMigrateWithRecovery(process.env, (message) =>
      logs.push(message)
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
  });

  it("preserves first migrate output when retry fails for another reason", () => {
    mockSpawnSequence([
      {
        status: 1,
        stderr:
          "duplicate key value violates unique constraint on drizzle.__drizzle_migrations",
      },
      { status: 0, stdout: "backfilled journal" },
      { status: 2, stderr: "connection refused" },
    ]);

    const result = runMigrateWithRecovery(process.env, () => undefined);

    expect(result.ok).toBe(false);
    expect(result.firstOutput).toContain("__drizzle_migrations");
    expect(result.output).toContain("__drizzle_migrations");
    expect(result.output).toContain("connection refused");
    expect(result.status).toBe(2);
  });

  it("does not run backfill for non-drift migrate failures", () => {
    mockSpawnSequence([{ status: 1, stderr: "syntax error at or near" }]);

    const result = runMigrateWithRecovery(process.env, () => undefined);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("syntax error");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
