import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {},
  workflows: {},
}));

import {
  digestWindowStart,
  isDigestDue,
} from "@/lib/notifications/execution-digest";

// 2026-06-02 is a Tuesday (UTC); 2026-06-04 is a Thursday (a non-digest day).
const TUESDAY = new Date("2026-06-02T14:00:00.000Z");
const THURSDAY = new Date("2026-06-04T14:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function minus(base: Date, ms: number): Date {
  return new Date(base.getTime() - ms);
}

describe("isDigestDue daily", () => {
  it("is due when never sent", () => {
    expect(isDigestDue("daily", null, TUESDAY)).toBe(true);
  });

  it("is due ~24h later, not shortly after", () => {
    expect(isDigestDue("daily", minus(TUESDAY, DAY), TUESDAY)).toBe(true);
    expect(isDigestDue("daily", minus(TUESDAY, 2 * HOUR), TUESDAY)).toBe(false);
  });

  it("tolerates a slightly-early cron firing (>= 23h)", () => {
    expect(isDigestDue("daily", minus(TUESDAY, 23 * HOUR), TUESDAY)).toBe(true);
    expect(isDigestDue("daily", minus(TUESDAY, 22 * HOUR), TUESDAY)).toBe(
      false
    );
  });
});

describe("isDigestDue weekly (Tuesday-pinned)", () => {
  it("is due on Tuesday when never sent", () => {
    expect(isDigestDue("weekly", null, TUESDAY)).toBe(true);
  });

  it("is not due on a non-Tuesday, even after a week", () => {
    expect(isDigestDue("weekly", null, THURSDAY)).toBe(false);
    expect(isDigestDue("weekly", minus(THURSDAY, 8 * DAY), THURSDAY)).toBe(
      false
    );
  });

  it("is due again the next Tuesday", () => {
    expect(isDigestDue("weekly", minus(TUESDAY, 7 * DAY), TUESDAY)).toBe(true);
  });

  it("does not re-send twice on the same Tuesday", () => {
    expect(isDigestDue("weekly", minus(TUESDAY, 3 * HOUR), TUESDAY)).toBe(
      false
    );
  });
});

describe("digestWindowStart", () => {
  it("returns 24h back for daily", () => {
    expect(digestWindowStart("daily", TUESDAY).toISOString()).toBe(
      "2026-06-01T14:00:00.000Z"
    );
  });

  it("returns 7d back for weekly", () => {
    expect(digestWindowStart("weekly", TUESDAY).toISOString()).toBe(
      "2026-05-26T14:00:00.000Z"
    );
  });
});
