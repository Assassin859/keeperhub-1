import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/utils/id", () => ({ generateId: () => "exec_test" }));

// Hoisted state the fake tx reads from / writes to, set per test.
const state = vi.hoisted(() => ({
  caps: [] as Array<{ dailyValueCapWei: string | null }>,
  sumRows: [] as Array<{ totalWei: string }>,
  inserted: [] as Record<string, unknown>[],
}));

// Fake db.transaction whose tx supports what the reservation uses: the cap
// FOR UPDATE lookup (.for().limit()), the value SUM (a thenable .where()), and
// the reservation insert.
vi.mock("@/lib/db", () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => {
      let selectCall = 0;
      const tx = {
        select: () => {
          selectCall += 1;
          if (selectCall === 1) {
            return {
              from: () => ({
                where: () => ({
                  for: () => ({
                    limit: () => Promise.resolve(state.caps),
                  }),
                }),
              }),
            };
          }
          return {
            from: () => ({
              where: () => Promise.resolve(state.sumRows),
            }),
          };
        },
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            state.inserted.push(v);
            return Promise.resolve(undefined);
          },
        }),
      };
      return cb(tx);
    },
  },
}));

import { checkAndReserveExecution } from "@/app/api/execute/_lib/spending-cap";

const baseParams = {
  organizationId: "org_1",
  apiKeyId: "key_1",
  type: "transfer",
  network: "1",
  input: { foo: "bar" },
};

beforeEach(() => {
  state.caps = [];
  state.sumRows = [{ totalWei: "0" }];
  state.inserted = [];
});

describe("checkAndReserveExecution value cap", () => {
  it("allows and records the reserved value when no cap row exists (unlimited)", async () => {
    state.caps = [];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reservedValueWei: "5",
    });

    expect(result).toEqual({ allowed: true, executionId: "exec_test" });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      valueWei: "5",
      status: "pending",
    });
  });

  it("treats a null dailyValueCapWei as unlimited", async () => {
    state.caps = [{ dailyValueCapWei: null }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reservedValueWei: "999",
    });

    expect(result.allowed).toBe(true);
    expect(state.inserted).toHaveLength(1);
  });

  it("allows when the day's total plus this reservation stays within the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.sumRows = [{ totalWei: "600" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reservedValueWei: "400",
    });

    expect(result.allowed).toBe(true);
    expect(state.inserted[0]).toMatchObject({ valueWei: "400" });
  });

  it("denies when the reservation would push the day's total over the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.sumRows = [{ totalWei: "600" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reservedValueWei: "500",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("blocks a single wallet-draining reservation even with a zero recorded total (TOCTOU closed)", async () => {
    // The reservation alone (5 ETH) exceeds a 1 ETH cap although the recorded
    // day total is still 0 -- value is known up front, unlike gas.
    state.caps = [{ dailyValueCapWei: "1000000000000000000" }];
    state.sumRows = [{ totalWei: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reservedValueWei: "5000000000000000000",
    });

    expect(result.allowed).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });
});
