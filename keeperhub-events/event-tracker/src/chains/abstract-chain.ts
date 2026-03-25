import { SendMessageCommand } from "@aws-sdk/client-sqs";
import axios from "axios";
import {
  JWT_TOKEN_PASSWORD,
  JWT_TOKEN_USERNAME,
  KEEPERHUB_API_URL,
  SQS_QUEUE_URL,
} from "../../lib/config/environment";
import { sqs } from "../../lib/sqs-client";
import type { WorkflowEvent } from "../../lib/models/workflow-event";
import type { NetworkConfig, NetworksWrapper } from "../../lib/types";
import { type Logger, logger } from "../../lib/utils/logger";

export class AbstractChain {
  executionLogs: { logs: any[] } = {
    logs: [],
  };

  chain: string;
  logger: Logger;
  event: WorkflowEvent;
  network: NetworkConfig;
  contractTransaction: any;
  contractInformation: any;

  constructor(
    event: WorkflowEvent,
    loggerInstance: Logger,
    networks: NetworksWrapper,
  ) {
    const { network: chainId } = event.workflow.node.data.config;
    const networksDict = networks.networks || (networks as any);
    const network = networksDict[Number(chainId)];
    this.chain = event.workflow.node.data.config.network;
    this.logger = loggerInstance;
    this.event = event;
    this.network = network;
    this.contractTransaction = null;
    this.contractInformation = null;
  }

  getProvider(): any {
    throw new Error("Method not implemented");
  }

  listenEvent(): any {
    throw new Error("Method not implemented");
  }

  async executeWorkflow(workflowId: string, payload: any): Promise<boolean> {
    try {
      const message = {
        workflowId,
        userId: this.event.workflow.userId,
        triggerType: "event" as const,
        triggerData: payload,
      };

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: SQS_QUEUE_URL,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            TriggerType: {
              DataType: "String",
              StringValue: "event",
            },
            WorkflowId: {
              DataType: "String",
              StringValue: workflowId,
            },
          },
        }),
      );

      logger.log(
        `[SQS] Enqueued workflow ${workflowId} for event execution`,
      );
      return true;
    } catch (error: any) {
      logger.error(`Error enqueuing workflow to SQS: ${error.message}`);
      return false;
    }
  }

  async authorize(): Promise<string> {
    const payload = new URLSearchParams();
    payload.append("username", JWT_TOKEN_USERNAME);
    payload.append("password", JWT_TOKEN_PASSWORD);

    const { data } = await axios.post(
      `${KEEPERHUB_API_URL}/auth/token`,
      payload,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    return data.access_token;
  }

  parseDataType(value: any, type: string): any {
    if (type === "address") {
      return `"${String(value)}"`;
    }

    if (type === "string") {
      return `"${String(value)}"`;
    }

    if (type === "bool") {
      return `"${Boolean(value)}"`;
    }

    if (type === "bytes") {
      return `"${String(value)}"`;
    }

    if (type === "bytes32") {
      return `"${String(value)}"`;
    }

    if (type.includes("uint")) {
      return `"${BigInt(value)}"`;
    }

    if (type.includes("int")) {
      return `"${BigInt(value)}"`;
    }

    return value;
  }

  cleanLogs(): void {
    this.executionLogs.logs = [];
  }
}
