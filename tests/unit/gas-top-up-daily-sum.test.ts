import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { sumOrgGasTopUpTodayMicroUsd } from "@/lib/execute/value-ledger";

const dialect = new PgDialect();

// Captures the select fields and where clause, and answers with `rows`.
function fakeExecutor(rows: Array<{ totalMicroUsd: string }>) {
  const captured: { fields?: Record<string, SQL>; where?: SQL } = {};
  const executor = {
    select: (fields: Record<string, SQL>) => {
      captured.fields = fields;
      return {
        from: () => ({
          where: (where: SQL) => {
            captured.where = where;
            return Promise.resolve(rows);
          },
        }),
      };
    },
  };
  return { executor, captured };
}

function render(fragment: SQL | undefined): { sql: string; params: unknown[] } {
  if (!fragment) {
    throw new Error("query fragment was not captured");
  }
  return dialect.sqlToQuery(fragment);
}

describe("sumOrgGasTopUpTodayMicroUsd", () => {
  it("returns the day's total as a bigint", async () => {
    const { executor } = fakeExecutor([{ totalMicroUsd: "150000000" }]);

    await expect(sumOrgGasTopUpTodayMicroUsd(executor, "org_1")).resolves.toBe(
      BigInt(150_000_000)
    );
  });

  it("treats an empty result as zero", async () => {
    const { executor } = fakeExecutor([]);

    await expect(sumOrgGasTopUpTodayMicroUsd(executor, "org_1")).resolves.toBe(
      BigInt(0)
    );
  });

  it("sums the recorded micro-USD amount of this org's gas top-ups", async () => {
    const { executor, captured } = fakeExecutor([{ totalMicroUsd: "0" }]);

    await sumOrgGasTopUpTodayMicroUsd(executor, "org_1");

    const total = render(captured.fields?.totalMicroUsd);
    expect(total.sql).toContain("->>'amountMicroUsd'");

    const where = render(captured.where);
    expect(where.params).toEqual(
      expect.arrayContaining(["org_1", "gas-top-up"])
    );
  });

  it("still counts a failed run whose swap landed, and in-flight rows of any age", async () => {
    const { executor, captured } = fakeExecutor([{ totalMicroUsd: "0" }]);

    await sumOrgGasTopUpTodayMicroUsd(executor, "org_1");

    const where = render(captured.where).sql;
    expect(where).toContain("IN ('completed', 'unconfirmed')");
    expect(where).toContain("= 'failed' AND");
    expect(where).toContain("->>'swapLanded' = 'true'");
    expect(where).toContain("IN ('pending', 'running')");
    // A run's worst case outlasts any fixed window and a crashed run is never
    // swept, so in-flight rows count until the UTC day ends.
    expect(where).not.toContain("interval");
  });
});
