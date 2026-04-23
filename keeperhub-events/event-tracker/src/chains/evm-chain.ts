import type { ethers } from "ethers";
import {
  REDIS_HOST,
  REDIS_PASSWORD,
  REDIS_PORT,
} from "../../lib/config/environment";
import type { WorkflowEvent } from "../../lib/models/workflow-event";
import type { NetworksWrapper } from "../../lib/types";
import { EXIT_CODES } from "../../lib/utils/constants";
import { type Logger, logger } from "../../lib/utils/logger";
import { AbstractChain } from "./abstract-chain";
import {
  buildEventAbi,
  buildEventPayload,
  extractEventArgs,
} from "./event-serializer";
import { getInterface } from "./interface-cache";
import { TransactionDedup } from "./transaction-dedup";
import type { AbiEvent } from "./validation";
import {
  validateAbiHasEvent,
  validateContractAddress,
  validateContractImplementsEvent,
} from "./validation";
import { WsConnection, is503Error } from "./ws-connection";

export class EvmChain extends AbstractChain {
  target: string;
  wssUrl: string;
  rpcUrl: string;
  abi: any[];
  options: WorkflowEvent;
  eventListener: any;
  eventFilter: any;
  initializationFailed: boolean;
  isInitialized: boolean;
  private connection: WsConnection | null;
  private dedup: TransactionDedup;

  constructor(
    options: WorkflowEvent,
    loggerInstance: Logger,
    networks: NetworksWrapper,
  ) {
    const { network: chainId } = options.workflow.node.data.config;

    const networksDict = networks.networks || (networks as any);
    const network = networksDict[Number(chainId)];

    super(options, loggerInstance, networks);

    const contractABI = options.getParsedABI();
    const contractAddress = options.contractAddress;

    this.target = contractAddress!;
    this.wssUrl = network.defaultPrimaryWss;
    this.rpcUrl = network.defaultPrimaryRpc;
    this.abi = contractABI;
    this.options = options;

    this.eventListener = null;
    this.eventFilter = null;

    this.initializationFailed = false;
    this.isInitialized = false;
    this.connection = null;

    this.dedup = new TransactionDedup(
      this.options.id!,
      REDIS_HOST,
      REDIS_PORT,
      REDIS_PASSWORD,
    );
  }

  async initializeProvider(): Promise<void> {
    const prefix = this.getLogPrefix();

    if (this.isInitialized || this.initializationFailed) {
      logger.log(
        `${prefix} [Provider] Already initialized or failed, skipping initialization`,
      );
      return;
    }

    try {
      logger.log(
        `${prefix} [Validation] Validating contract address ${this.target} on network using RPC: ${this.rpcUrl}`,
      );
      const addressValidation = await validateContractAddress(
        this.target,
        this.rpcUrl,
      );

      if (!addressValidation.isValid) {
        logger.warn(
          `${prefix} [Validation] Contract address validation failed: ${addressValidation.error}`,
        );
        this.initializationFailed = true;

        process?.send?.({
          status: "validation_failed",
          reason: "invalid_contract_address",
          pid: process.pid,
          error: addressValidation.error,
        });

        process.exit(EXIT_CODES.VALIDATION_ERROR);
      }

      logger.log(
        `${prefix} [Validation] Validating ABI contains event '${this.options.eventName}'`,
      );
      const abiValidation = validateAbiHasEvent(
        this.abi,
        this.options.eventName!,
      );

      if (!abiValidation.isValid) {
        logger.warn(
          `${prefix} [Validation] ABI validation failed: ${abiValidation.error}`,
        );
        this.initializationFailed = true;

        process?.send?.({
          status: "validation_failed",
          reason: "invalid_abi",
          pid: process.pid,
          error: abiValidation.error,
        });

        process.exit(EXIT_CODES.VALIDATION_ERROR);
      }

      logger.log(
        `${prefix} [Validation] Validating contract implements event '${this.options.eventName}'`,
      );
      const implementsValidation = await validateContractImplementsEvent(
        this.target,
        this.rpcUrl,
        this.abi,
        this.options.eventName!,
      );

      if (!implementsValidation.isValid) {
        logger.warn(
          `${prefix} [Validation] Contract event validation warning: ${implementsValidation.error}`,
        );
      }

      this.connection = new WsConnection({
        wssUrl: this.wssUrl,
        getLogPrefix: () => this.getLogPrefix(),
        onReconnected: () => this.listenEvent(),
      });

      await this.connection.initialize();
      this.isInitialized = true;
    } catch (error: any) {
      logger.warn(
        `${prefix} [Provider] Failed to initialize provider: ${error.message}`,
      );

      if (is503Error(error)) {
        logger.warn(
          `${prefix} [Provider] 503 Service Unavailable detected during initialization`,
        );
        this.initializationFailed = true;

        process?.send?.({
          status: "initialization_failed",
          reason: "503_service_unavailable",
          pid: process.pid,
          error: error.message,
        });

        logger.log(
          `${prefix} [Provider] Exiting process for restart due to 503 error`,
        );
        process.exit(EXIT_CODES.TRANSIENT_ERROR);
      }

      throw error;
    }
  }

  getLogPrefix(): string {
    const pid = process?.pid || "?";
    const chainId = this.options?.workflow?.node?.data?.config?.network || "?";
    const eventName = this.options?.eventName || "?";
    const contractAddr = this.target ? logger.formatAddress(this.target) : "?";
    const workflowId = this.options?.id || "?";
    const workflowName = this.options?.name || "?";
    return `[${pid}|${chainId}|${eventName}|${contractAddr}|${workflowId}|${workflowName}]`;
  }

  getProvider(): ethers.WebSocketProvider | null {
    return this.connection?.getProvider() ?? null;
  }

  async handleMatchedEvent(
    log: ethers.Log,
    parsedLog: any,
    rawEventsAbi: AbiEvent[],
  ): Promise<void> {
    const transactionHash = log.transactionHash;

    if (await this.dedup.isProcessed(transactionHash)) {
      logger.log(`Transaction already processed: ${transactionHash}`);
      return;
    }
    await this.dedup.markProcessed(transactionHash);

    const args = extractEventArgs(parsedLog, rawEventsAbi);
    const payload = buildEventPayload(log, parsedLog, args);

    logger.log(
      `Event matched ~ [ KeeperID: ${this.options.id} - ${this.options.name} ]`,
    );
    logger.log(
      `Executing workflow with payload: ${JSON.stringify(payload, null, 2)}`,
    );
    await this.executeWorkflow(this.options.id!, payload);
  }

  async processEventLog(
    log: ethers.Log,
    abiInterface: ethers.Interface,
    rawEventsAbi: AbiEvent[],
  ): Promise<void> {
    try {
      const parsedLog = abiInterface.parseLog(log);
      const { eventName } = this.options.workflow.node.data.config;

      if (parsedLog?.args && parsedLog.name === eventName) {
        const jitterMs = Math.random() * 10 * 1000;
        await new Promise((resolve) => setTimeout(resolve, jitterMs));

        logger.log(`Event name ~ [ ${eventName} ]`);
        logger.log(`Parsed log name: ${parsedLog.name}`);
        await this.handleMatchedEvent(log, parsedLog, rawEventsAbi);
      } else {
        logger.log("Event name mismatch / No args present");
        logger.log(`parsedLog.name: ${parsedLog?.name}`);
        logger.log(`Expected eventName: ${eventName}`);
      }
    } catch (error: any) {
      logger.warn(error);
    }
  }

  async listenEvent(): Promise<void> {
    const prefix = this.getLogPrefix();
    const formatDate = (date: Date): string =>
      date.toLocaleString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

    if (!this.connection && !this.initializationFailed) {
      logger.log(
        `${prefix} [ListenEvent] Provider not initialized, starting initialization...`,
      );
      await this.initializeProvider();

      if (this.initializationFailed || !this.connection) {
        logger.warn(
          `${prefix} [ListenEvent] Provider initialization failed, cannot listen for events`,
        );
        return;
      }
    }

    if (this.initializationFailed) {
      logger.warn(
        `${prefix} [ListenEvent] Provider initialization previously failed, cannot listen for events`,
      );
      return;
    }

    if (this.eventListener && this.eventFilter) {
      logger.log(`[${formatDate(new Date())}] Cleaning up existing listener`);
      this.connection!.removeEventFilter(this.eventFilter);
      this.eventListener = null;
      this.eventFilter = null;
    }

    logger.log(
      `[${formatDate(new Date())}] Creating new event listener for event: ${
        this.options.eventName
      } - address: ${logger.formatAddress(this.target)} - workflow: ${
        this.options.workflow.name
      }`,
    );

    const filter = { address: this.target };
    this.eventFilter = filter;
    const rawEventsAbi = this.abi.filter(
      ({ type }: { type: string }) => type === "event",
    );
    const eventsAbi = rawEventsAbi.map(buildEventAbi);
    const abiInterface = getInterface(eventsAbi);

    this.eventListener = this.connection!.on(
      filter,
      async (log: ethers.Log) => {
        logger.log(
          `[${formatDate(new Date())}] Event detected: ${JSON.stringify({
            contractAddress: log.address,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
          })}`,
        );

        await this.processEventLog(log, abiInterface, rawEventsAbi);
      },
    );

    this.connection!.startHeartbeat();
  }

  async destroy(): Promise<void> {
    const prefix = this.getLogPrefix();
    logger.log(`${prefix} [Cleanup] Destroying EvmChain instance...`);

    if (this.eventFilter && this.connection) {
      this.connection.removeEventFilter(this.eventFilter);
      logger.log(`${prefix} [Cleanup] Event listener removed`);
    }

    if (this.connection) {
      await this.connection.destroy();
    }

    try {
      await this.dedup.quit();
      logger.log(`${prefix} [Cleanup] Redis connection closed`);
    } catch (e: any) {
      logger.log(`${prefix} [Cleanup] Error closing Redis: ${e.message}`);
    }

    logger.log(`${prefix} [Cleanup] EvmChain instance destroyed`);
  }
}
