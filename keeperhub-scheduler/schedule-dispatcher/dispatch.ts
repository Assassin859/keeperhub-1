/**
 * Schedule dispatcher logic.
 *
 * Pure functions extracted from index.ts so they can be unit-tested in
 * isolation. index.ts is now only the entry point: it composes these
 * functions, registers signal handlers, and runs the polling loop.
 *
 * Note: importing this module triggers SQS client instantiation as a
 * side effect (via lib/sqs-client.js, which calls `new SQSClient(...)` at
 * module load). The functions below are pure, but the import is not.
 * Tests must mock "../lib/sqs-client.js" to avoid contacting AWS.
 */

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { CronExpressionParser } from "cron-parser";
import {
  KEEPERHUB_URL,
  SERVICE_API_KEY,
  SQS_QUEUE_URL,
} from "../lib/config.js";
import { sqs } from "../lib/sqs-client.js";
import type { Schedule, ScheduleMessage } from "../lib/types.js";

export type DispatchResult = {
  evaluated: number;
  triggered: number;
  errors: number;
};

export async function fetchSchedules(): Promise<Schedule[]> {
  const response = await fetch(`${KEEPERHUB_URL}/api/internal/schedules`, {
    method: "GET",
    headers: {
      "X-Service-Key": SERVICE_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch schedules: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as { schedules: Schedule[] };
  return data.schedules;
}

/**
 * Returns true when the cron expression's most recent occurrence is within
 * the current minute (now - prev < 60_000ms). Returns false on invalid
 * expressions and logs the error.
 */
export function shouldTriggerNow(
  cronExpression: string,
  timezone: string,
  now: Date,
): boolean {
  try {
    // cron-parser's prev() is strict — at exactly 09:00:00.000 with cron
    // `0 9 * * *`, prev() returns yesterday's 9am rather than today's, so
    // a dispatch tick that happens to land on a minute boundary skips the
    // schedule. Bump currentDate by 1ms so an occurrence at exactly `now`
    // is treated as in the past.
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(now.getTime() + 1),
      tz: timezone,
    });

    const prev = interval.prev().toDate();
    const diffMs = now.getTime() - prev.getTime();

    return diffMs >= 0 && diffMs < 60_000;
  } catch (error) {
    console.error(`Invalid cron expression: ${cronExpression}`, error);
    return false;
  }
}

export async function sendToQueue(message: ScheduleMessage): Promise<void> {
  const command = new SendMessageCommand({
    QueueUrl: SQS_QUEUE_URL,
    MessageBody: JSON.stringify(message),
    MessageAttributes: {
      TriggerType: {
        DataType: "String",
        StringValue: "schedule",
      },
      WorkflowId: {
        DataType: "String",
        StringValue: message.workflowId,
      },
    },
  });

  await sqs.send(command);
}

/**
 * One dispatch pass: fetch schedules, evaluate each against the current
 * time, enqueue triggers for matching ones. Per-schedule failures are
 * logged and counted but do not abort the pass.
 */
export async function dispatch(): Promise<DispatchResult> {
  const runId = crypto.randomUUID().slice(0, 8);
  console.log(
    `[${runId}] Starting dispatch run at ${new Date().toISOString()}`,
  );

  const schedules = await fetchSchedules();

  console.log(`[${runId}] Found ${schedules.length} enabled schedules`);

  const now = new Date();
  let triggered = 0;
  let errors = 0;

  for (const schedule of schedules) {
    try {
      const shouldTrigger = shouldTriggerNow(
        schedule.cronExpression,
        schedule.timezone,
        now,
      );

      if (shouldTrigger) {
        console.log(
          `[${runId}] Triggering workflow ${schedule.workflowId} ` +
            `(cron: ${schedule.cronExpression}, tz: ${schedule.timezone})`,
        );

        await sendToQueue({
          workflowId: schedule.workflowId,
          scheduleId: schedule.id,
          triggerTime: now.toISOString(),
          triggerType: "schedule",
        });

        triggered += 1;
      }
    } catch (error) {
      console.error(
        `[${runId}] Error processing schedule ${schedule.id}:`,
        error,
      );
      errors += 1;
    }
  }

  console.log(
    `[${runId}] Dispatch complete: evaluated=${schedules.length}, triggered=${triggered}, errors=${errors}`,
  );

  return {
    evaluated: schedules.length,
    triggered,
    errors,
  };
}
