import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SQS_SIGNATURE_ATTR,
  signSqsMessageAttributes,
} from "../../lib/sqs-message-auth.js";

// Shared anti-drift vector. These exact inputs must produce this exact
// signature here, in the app's lib/sqs-message-auth.ts, and in the
// event-tracker copy. A mismatch means a copy drifted from the scheme and the
// executor would reject this producer's messages.
const FIXED_SECRET = "test-shared-secret";
const FIXED_BODY = JSON.stringify({
  workflowId: "wf_1",
  scheduleId: "sch_1",
  triggerTime: "2026-01-01T00:00:00.000Z",
  triggerType: "schedule",
});
const FIXED_TS = 1_700_000_000;
const FIXED_SIG =
  "f508ed8e583f7d2f61341526a735cefe45a4aa83d0befcb761ad5953fc48fca2";

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.INTERNAL_SERVICE_HMAC_SECRET;
  process.env.INTERNAL_SERVICE_HMAC_SECRET = FIXED_SECRET;
});

afterEach(() => {
  process.env.INTERNAL_SERVICE_HMAC_SECRET = savedSecret;
});

describe("scheduler sqs-message-auth", () => {
  it("matches the shared anti-drift signature vector", () => {
    const attrs = signSqsMessageAttributes("scheduler", FIXED_BODY, FIXED_TS);
    expect(attrs[SQS_SIGNATURE_ATTR].StringValue).toBe(FIXED_SIG);
  });
});
