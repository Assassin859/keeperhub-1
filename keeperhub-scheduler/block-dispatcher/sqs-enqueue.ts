/**
 * SQS Enqueue Helper for Block Triggers
 *
 * Sends block trigger messages to the shared SQS queue.
 */

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqs } from "../lib/sqs-client.js";
import { SQS_QUEUE_URL } from "../lib/config.js";
import type { BlockMessage } from "../lib/types.js";

export async function enqueueBlockTrigger(
  message: BlockMessage
): Promise<void> {
  console.log(
    `[SQS] Enqueuing block trigger: workflow=${message.workflowId}, block=${message.triggerData.blockNumber}`
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        TriggerType: {
          DataType: "String",
          StringValue: "block",
        },
        WorkflowId: {
          DataType: "String",
          StringValue: message.workflowId,
        },
      },
    })
  );
}
