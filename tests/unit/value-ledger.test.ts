import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/utils/id", () => ({ generateId: () => "res_gen" }));

// Hoisted state the fake db reads from / writes to, set per test.
const state = vi.hoisted(() => ({
  caps: [] as Array<{ dailyValueCapWei: string | null }>,
  directSum: [{ totalWei: "0" }] as Array<{ totalWei: string }>,
  ledgerSum: [{ totalWei: "0" }] as Array<{ totalWei: string }>,
  inserted: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  returningId: "res_1",
}));

// Fake db: transaction whose tx serves the cap FOR UPDATE lookup, then the two
// SUM selects (direct executions, then the value ledger) that
// sumOrgValueTodayWei runs, then the reservation insert (.returning). update()
// records the settle/release status.
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
          const rows = selectCall === 2 ? state.directSum : state.ledgerSum;
          return {
            from: () => ({ where: () => Promise.resolve(rows) }),
          };
        },
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            state.inserted.push(v);
            return {
              returning: () => Promise.resolve([{ id: state.returningId }]),
            };
          },
        }),
      };
      return cb(tx);
    },
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(s);
          return Promise.resolve(undefined);
        },
      }),
    }),
  },
}));

import {
  reserveOrgValue,
  withStepValueCap,
  withValueCap,
} from "@/lib/execute/value-ledger";

const ONE_ETH_WEI = "1000000000000000000";

beforeEach(() => {
  state.caps = [];
  state.directSum = [{ totalWei: "0" }];
  state.ledgerSum = [{ totalWei: "0" }];
  state.inserted = [];
  state.updates = [];
  state.returningId = "res_1";
});

describe("reserveOrgValue", () => {
  it("is unlimited (records nothing) when no cap row exists", async () => {
    state.caps = [];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "500",
    });

    expect(result).toEqual({ allowed: true, reservationId: "" });
    expect(state.inserted).toHaveLength(0);
  });

  it("treats a null daily value cap as unlimited", async () => {
    state.caps = [{ dailyValueCapWei: null }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: ONE_ETH_WEI,
    });

    expect(result).toEqual({ allowed: true, reservationId: "" });
    expect(state.inserted).toHaveLength(0);
  });

  it("allows and inserts a reserved row within the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.directSum = [{ totalWei: "600" }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "300",
      source: "workflow",
      ref: "exec_1",
    });

    expect(result).toEqual({ allowed: true, reservationId: "res_1" });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      valueWei: "300",
      status: "reserved",
      source: "workflow",
      ref: "exec_1",
    });
  });

  it("denies (no insert) when the reservation would exceed the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.directSum = [{ totalWei: "600" }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "500",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("counts prior direct-execution spend in its own SUM", async () => {
    // 900 already spent via the direct API (directSum) leaves only 100 room;
    // a 200 workflow reservation is denied. Proves the ledger path sees direct
    // spend, the mirror of the direct path seeing ledger spend.
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.directSum = [{ totalWei: "900" }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "200",
    });

    expect(result.allowed).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });
});

describe("withValueCap", () => {
  it("skips the cap and runs when the value is zero", async () => {
    const run = vi.fn().mockResolvedValue({ success: true, id: "ran" });

    const result = await withValueCap(
      { organizationId: "org_1", valueWei: "0" },
      run
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, id: "ran" });
    expect(state.inserted).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("reserves then settles on a successful result", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withValueCap(
      { organizationId: "org_1", valueWei: "100" },
      run
    );

    expect(result).toEqual({ success: true });
    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "settled" }),
    ]);
  });

  it("reserves then releases on a failed result", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    const run = vi.fn().mockResolvedValue({ success: false, error: "boom" });

    const result = await withValueCap(
      { organizationId: "org_1", valueWei: "100" },
      run
    );

    expect(result).toEqual({ success: false, error: "boom" });
    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "released" }),
    ]);
  });

  it("releases and rethrows when the run throws", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    const run = vi.fn().mockRejectedValue(new Error("kaboom"));

    await expect(
      withValueCap({ organizationId: "org_1", valueWei: "100" }, run)
    ).rejects.toThrow("kaboom");

    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "released" }),
    ]);
  });

  it("denies without running when over the cap", async () => {
    state.caps = [{ dailyValueCapWei: "100" }];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withValueCap(
      { organizationId: "org_1", valueWei: "500" },
      run
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Daily spending cap exceeded",
    });
    expect(state.updates).toHaveLength(0);
  });
});

describe("withStepValueCap", () => {
  it("runs without a cap check when the workflow has no organization", async () => {
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap({ amountEth: "1" }, run);

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true });
    expect(state.inserted).toHaveLength(0);
  });

  it("runs without a cap check when the step moves no native value", async () => {
    state.caps = [{ dailyValueCapWei: "1" }];
    const run = vi.fn().mockResolvedValue({ success: true });

    await withStepValueCap({ organizationId: "org_1", amountEth: "0" }, run);
    await withStepValueCap(
      { organizationId: "org_1", amountEth: undefined },
      run
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(state.inserted).toHaveLength(0);
  });

  it("blocks the value-moving core when a workflow step exceeds the cap", async () => {
    // The KEEP-933 fix: a 5 ETH transfer triggered from a workflow (not the
    // direct API) is now bounded by the same 1 ETH org cap. The core never runs.
    state.caps = [{ dailyValueCapWei: ONE_ETH_WEI }];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap(
      { organizationId: "org_1", amountEth: "5", executionId: "exec_1" },
      run
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Daily spending cap exceeded",
    });
  });

  it("runs and settles a workflow step within the cap", async () => {
    state.caps = [{ dailyValueCapWei: ONE_ETH_WEI }];
    const run = vi.fn().mockResolvedValue({ success: true, hash: "0xabc" });

    const result = await withStepValueCap(
      { organizationId: "org_1", amountEth: "0.5", executionId: "exec_1" },
      run
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, hash: "0xabc" });
    expect(state.inserted[0]).toMatchObject({
      valueWei: "500000000000000000",
      source: "workflow",
      ref: "exec_1",
    });
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "settled" }),
    ]);
  });
});
