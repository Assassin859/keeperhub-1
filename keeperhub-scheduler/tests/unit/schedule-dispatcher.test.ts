import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock the sqs-client module so importing dispatch.ts does not instantiate
// a real SQS client. The mock object's `send` is replaced per-test via
// vi.mocked(sqs.send) so each test can choose its own behavior.
vi.mock("../../lib/sqs-client.js", () => ({
  sqs: {
    send: vi.fn(),
  },
}));

import { sqs } from "../../lib/sqs-client.js";
import {
  dispatch,
  fetchSchedules,
  sendToQueue,
  shouldTriggerNow,
} from "../../schedule-dispatcher/dispatch.js";

const mockedSqsSend = vi.mocked(sqs.send);

// Silence the dispatcher's console output -- every dispatch run logs
// half a dozen lines per schedule. Restore in afterEach so test failures
// keep their stack traces visible.
let consoleLogSpy: MockInstance;
let consoleErrorSpy: MockInstance;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {
    /* swallow */
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
    /* swallow */
  });
  mockedSqsSend.mockReset();
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("shouldTriggerNow", () => {
  it("returns true when prev() is within the current minute", () => {
    // 9:00:01 UTC -- prev() of "0 9 * * *" returns 9:00:00, diff=1s.
    const now = new Date("2024-01-15T09:00:01Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(true);
  });

  it("returns true at 30 seconds into the matching minute", () => {
    const now = new Date("2024-01-15T09:00:30Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(true);
  });

  it("returns false at 60 seconds (window is exclusive)", () => {
    // At 9:01:00, diff from 9:00:00 is exactly 60_000ms -- not < 60_000.
    const now = new Date("2024-01-15T09:01:00Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(false);
  });

  it("returns false outside the matching minute", () => {
    const now = new Date("2024-01-15T08:30:00Z");
    expect(shouldTriggerNow("0 9 * * *", "UTC", now)).toBe(false);
  });

  it("matches at every minute for '* * * * *'", () => {
    const at = (s: string): Date => new Date(s);
    expect(
      shouldTriggerNow("* * * * *", "UTC", at("2024-01-15T14:37:01Z")),
    ).toBe(true);
    expect(
      shouldTriggerNow("* * * * *", "UTC", at("2024-01-15T03:00:30Z")),
    ).toBe(true);
  });

  it("matches an hourly cron at the top of the hour", () => {
    expect(
      shouldTriggerNow("0 * * * *", "UTC", new Date("2024-01-15T14:00:01Z")),
    ).toBe(true);
    expect(
      shouldTriggerNow("0 * * * *", "UTC", new Date("2024-01-15T14:30:00Z")),
    ).toBe(false);
  });

  it("respects the timezone parameter (NY 9am = 14:00 UTC in January)", () => {
    // EST is UTC-5 in January, so 9 AM NY == 14:00 UTC.
    expect(
      shouldTriggerNow(
        "0 9 * * *",
        "America/New_York",
        new Date("2024-01-15T14:00:01Z"),
      ),
    ).toBe(true);
    // 9 AM UTC is not 9 AM NY -- should not trigger.
    expect(
      shouldTriggerNow(
        "0 9 * * *",
        "America/New_York",
        new Date("2024-01-15T09:00:00Z"),
      ),
    ).toBe(false);
  });

  it("returns false and logs on an invalid cron expression", () => {
    const now = new Date("2024-01-15T09:00:00Z");
    expect(shouldTriggerNow("not a cron", "UTC", now)).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid cron expression: not a cron"),
      expect.anything(),
    );
  });

  it("respects day-of-week constraints", () => {
    // 2024-01-15 is a Monday at 9:00:01.
    const monday = new Date("2024-01-15T09:00:01Z");
    expect(shouldTriggerNow("0 9 * * 1", "UTC", monday)).toBe(true);
    // Tuesday-only cron should not match on Monday.
    expect(shouldTriggerNow("0 9 * * 2", "UTC", monday)).toBe(false);
  });

  it("respects step values", () => {
    // Every 15 minutes -- triggers at :00, :15, :30, :45 (+1s).
    expect(
      shouldTriggerNow("*/15 * * * *", "UTC", new Date("2024-01-15T09:00:01Z")),
    ).toBe(true);
    expect(
      shouldTriggerNow("*/15 * * * *", "UTC", new Date("2024-01-15T09:15:01Z")),
    ).toBe(true);
    // :10 is mid-window -- prev() returns :00, diff is ~10min -> false.
    expect(
      shouldTriggerNow("*/15 * * * *", "UTC", new Date("2024-01-15T09:10:01Z")),
    ).toBe(false);
  });
});

describe("fetchSchedules", () => {
  it("returns the schedules array on a 200 response", async () => {
    const schedules = [
      {
        id: "s1",
        workflowId: "w1",
        cronExpression: "* * * * *",
        timezone: "UTC",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ schedules }),
      }),
    );

    await expect(fetchSchedules()).resolves.toEqual(schedules);
  });

  it("returns an empty array when the API returns no schedules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ schedules: [] }),
      }),
    );

    await expect(fetchSchedules()).resolves.toEqual([]);
  });

  it("throws including the status and body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "service unavailable",
      }),
    );

    await expect(fetchSchedules()).rejects.toThrow(
      /Failed to fetch schedules: 503 service unavailable/,
    );
  });

  it("calls fetch with the schedules path and X-Service-Key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schedules: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchSchedules();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/internal\/schedules$/);
    expect(init).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({ "X-Service-Key": expect.any(String) }),
    });
  });
});

describe("sendToQueue", () => {
  it("sends one SQS message with the correct body and attributes", async () => {
    mockedSqsSend.mockResolvedValue({} as never);

    await sendToQueue({
      workflowId: "wf-1",
      scheduleId: "sched-1",
      triggerTime: "2024-01-15T09:00:00.000Z",
      triggerType: "schedule",
    });

    expect(mockedSqsSend).toHaveBeenCalledOnce();
    const command = mockedSqsSend.mock.calls[0][0] as {
      input: {
        QueueUrl: string;
        MessageBody: string;
        MessageAttributes: Record<
          string,
          { DataType: string; StringValue: string }
        >;
      };
    };
    expect(command.input.QueueUrl).toBeTruthy();
    expect(JSON.parse(command.input.MessageBody)).toEqual({
      workflowId: "wf-1",
      scheduleId: "sched-1",
      triggerTime: "2024-01-15T09:00:00.000Z",
      triggerType: "schedule",
    });
    expect(command.input.MessageAttributes.TriggerType).toEqual({
      DataType: "String",
      StringValue: "schedule",
    });
    expect(command.input.MessageAttributes.WorkflowId).toEqual({
      DataType: "String",
      StringValue: "wf-1",
    });
  });

  it("propagates errors from sqs.send", async () => {
    mockedSqsSend.mockRejectedValue(new Error("SQS unavailable"));

    await expect(
      sendToQueue({
        workflowId: "wf-1",
        scheduleId: "sched-1",
        triggerTime: "2024-01-15T09:00:00.000Z",
        triggerType: "schedule",
      }),
    ).rejects.toThrow("SQS unavailable");
  });
});

describe("dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 9:00:01 UTC -- inside the matching minute for "0 9 * * *".
    vi.setSystemTime(new Date("2024-01-15T09:00:01Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function stubFetch(schedules: unknown[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ schedules }),
      }),
    );
  }

  it("returns zero counts when no schedules are returned", async () => {
    stubFetch([]);

    await expect(dispatch()).resolves.toEqual({
      evaluated: 0,
      triggered: 0,
      errors: 0,
    });
    expect(mockedSqsSend).not.toHaveBeenCalled();
  });

  it("triggers a matching schedule and counts it once", async () => {
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend.mockResolvedValue({} as never);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 1, errors: 0 });
    expect(mockedSqsSend).toHaveBeenCalledOnce();
  });

  it("does not enqueue a schedule that is not due", async () => {
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      },
    ]);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 0, errors: 0 });
    expect(mockedSqsSend).not.toHaveBeenCalled();
  });

  it("counts SQS failures as errors but keeps processing", async () => {
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        id: "sched-2",
        workflowId: "wf-2",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend
      .mockRejectedValueOnce(new Error("SQS down"))
      .mockResolvedValueOnce({} as never);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 2, triggered: 1, errors: 1 });
    expect(mockedSqsSend).toHaveBeenCalledTimes(2);
  });

  it("treats a malformed cron as not-due rather than as an error", async () => {
    // shouldTriggerNow logs the parse failure and returns false; dispatch
    // sees that as "not due" and does not increment errors. Pinned so a
    // future change here is a deliberate decision, not an accident.
    stubFetch([
      {
        id: "sched-1",
        workflowId: "wf-1",
        cronExpression: "this is not cron",
        timezone: "UTC",
      },
    ]);

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 1, triggered: 0, errors: 0 });
    expect(mockedSqsSend).not.toHaveBeenCalled();
  });

  it("processes a mixed batch (due, not-due, due-but-sqs-fails)", async () => {
    stubFetch([
      {
        id: "s-ok",
        workflowId: "wf-ok",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        id: "s-skip",
        workflowId: "wf-skip",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      },
      {
        id: "s-fail",
        workflowId: "wf-fail",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    ]);
    mockedSqsSend
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("SQS down"));

    const result = await dispatch();

    expect(result).toEqual({ evaluated: 3, triggered: 1, errors: 1 });
    expect(mockedSqsSend).toHaveBeenCalledTimes(2);
  });

  it("propagates fetchSchedules failures to the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom",
      }),
    );

    await expect(dispatch()).rejects.toThrow(/Failed to fetch schedules: 500/);
    expect(mockedSqsSend).not.toHaveBeenCalled();
  });
});
