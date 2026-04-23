import { type SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

/**
 * Shape of every event-trigger message the tracker enqueues to SQS. Kept
 * in one place so the fork-path (`AbstractChain.executeWorkflow`) and
 * the in-process path (`EventListener.sendToSqs`) can not drift from
 * each other as the refactor progresses.
 *
 * Phase 6 will delete the fork path and this helper survives as the sole
 * producer of the SQS contract.
 */

export interface WorkflowEventTrigger {
  workflowId: string;
  userId: string;
  triggerData: unknown;
}

export async function enqueueWorkflowEventTrigger(
  client: SQSClient,
  queueUrl: string,
  trigger: WorkflowEventTrigger,
): Promise<void> {
  const body = {
    workflowId: trigger.workflowId,
    userId: trigger.userId,
    triggerType: "event" as const,
    triggerData: trigger.triggerData,
  };
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageAttributes: {
        TriggerType: { DataType: "String", StringValue: "event" },
        WorkflowId: {
          DataType: "String",
          StringValue: trigger.workflowId,
        },
      },
    }),
  );
}
