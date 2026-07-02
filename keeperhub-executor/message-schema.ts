import { z } from "zod";

/**
 * Runtime validation for SQS trigger message bodies, mirroring the TypeScript
 * union in ./types.ts (ExecutorMessage). The consumer previously cast the
 * JSON.parse result straight to ExecutorMessage with no shape check; this gates
 * the parsed body before any workflow load/dispatch.
 *
 * Identity fields (workflowId, triggerType, and executionId where the producer
 * always sends one) are strict. Free-form payloads (triggerData / input) are
 * left permissive on purpose so a legitimate producer payload is never rejected
 * - the security-relevant fields are the identity ones. Unknown extra top-level
 * keys are stripped by default (not an error).
 *
 * Keep in sync with ./types.ts.
 */

const workflowId = z.string().min(1);
const payload = z.record(z.string(), z.unknown());

const scheduleMessageSchema = z.object({
  triggerType: z.literal("schedule"),
  workflowId,
  scheduleId: z.string().min(1),
  triggerTime: z.string(),
  executionId: z.string().optional(),
});

const blockMessageSchema = z.object({
  triggerType: z.literal("block"),
  workflowId,
  userId: z.string(),
  executionId: z.string().optional(),
  triggerData: z.object({
    blockNumber: z.number(),
    blockHash: z.string(),
    blockTimestamp: z.number(),
    parentHash: z.string(),
  }),
});

const eventMessageSchema = z.object({
  triggerType: z.literal("event"),
  workflowId,
  userId: z.string(),
  executionId: z.string().optional(),
  triggerData: payload,
});

// manual and webhook share a shape but are separate literal branches so the
// discriminated union stays on a single literal discriminator per branch.
const manualFields = {
  workflowId,
  userId: z.string(),
  executionId: z.string().min(1),
  organizationId: z.string().optional(),
  input: payload,
};
const manualMessageSchema = z.object({
  triggerType: z.literal("manual"),
  ...manualFields,
});
const webhookMessageSchema = z.object({
  triggerType: z.literal("webhook"),
  ...manualFields,
});

export const executorMessageSchema = z.discriminatedUnion("triggerType", [
  scheduleMessageSchema,
  blockMessageSchema,
  eventMessageSchema,
  manualMessageSchema,
  webhookMessageSchema,
]);
