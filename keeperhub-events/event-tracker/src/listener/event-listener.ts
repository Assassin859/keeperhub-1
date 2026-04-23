import type { SQSClient } from "@aws-sdk/client-sqs";
import type { ethers } from "ethers";
import { logger } from "../../lib/utils/logger";
import { enqueueWorkflowEventTrigger } from "../../lib/workflow-sqs";
import {
  buildEventPayload,
  extractEventArgs,
} from "../chains/event-serializer";
import { getInterface } from "../chains/interface-cache";
import type {
  ChainProviderManager,
  Unsubscribe,
} from "../chains/provider-manager";
import type { AbiEvent } from "../chains/validation";
import type { DedupStore } from "./dedup";
import { formatError } from "./format-error";

/**
 * EventListener encapsulates a single workflow's contract-event listener
 * running in-process (no child_process.fork). It registers with
 * ChainProviderManager's shared block-subscription + demux, so many
 * listeners on the same chain share one WSS connection.
 *
 * Phase 3 scope: standalone class + unit tests. Phase 4 wires the
 * ListenerRegistry into `main.ts` behind the ENABLE_INPROC_LISTENERS
 * feature flag.
 */

const DEFAULT_JITTER_MS = 10_000;

export interface EventListenerOptions {
  workflowId: string;
  userId: string;
  workflowName: string;
  chainId: number;
  wssUrl: string;
  contractAddress: string;
  eventName: string;
  eventsAbiStrings: string[];
  rawEventsAbi: AbiEvent[];

  sqs: SQSClient;
  sqsQueueUrl: string;
  dedup: DedupStore;
  providerManager: ChainProviderManager;

  /**
   * Maximum jitter applied before forwarding a matched event to SQS. Keeps
   * parity with the existing `evm-chain.ts:processEventLog` behaviour which
   * spreads downstream load when many events fire simultaneously. Tests
   * should pass 0 to keep runs deterministic.
   */
  jitterMs?: number;
}

export class EventListener {
  private readonly opts: EventListenerOptions;
  private unsubscribe: Unsubscribe | null = null;
  private started = false;

  constructor(opts: EventListenerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const iface = getInterface(this.opts.eventsAbiStrings);
    const eventFragment = iface.getEvent(this.opts.eventName);
    if (!eventFragment) {
      throw new Error(
        `EventListener(${this.opts.workflowId}): event "${this.opts.eventName}" not found in ABI`,
      );
    }

    this.unsubscribe = await this.opts.providerManager.subscribeToLogs({
      chainId: this.opts.chainId,
      wssUrl: this.opts.wssUrl,
      address: this.opts.contractAddress,
      topic0: eventFragment.topicHash,
      handler: (log) => this.onLog(log),
    });
    this.started = true;
    logger.log(
      `[EventListener:${this.opts.workflowId}] started - name="${this.opts.workflowName}" chain=${this.opts.chainId} address=${this.opts.contractAddress} event=${this.opts.eventName}`,
    );
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    logger.log(`[EventListener:${this.opts.workflowId}] stopped`);
  }

  isStarted(): boolean {
    return this.started;
  }

  private async onLog(log: ethers.Log): Promise<void> {
    try {
      const iface = getInterface(this.opts.eventsAbiStrings);
      const parsed = iface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (!parsed || parsed.name !== this.opts.eventName) {
        return;
      }

      const txHash = log.transactionHash;
      if (!txHash) {
        logger.warn(
          `[EventListener:${this.opts.workflowId}] log missing transactionHash; skipping`,
        );
        return;
      }

      const maxJitter = this.opts.jitterMs ?? DEFAULT_JITTER_MS;
      if (maxJitter > 0) {
        await new Promise((r) => setTimeout(r, Math.random() * maxJitter));
      }

      // Dedup is best-effort. If the read throws we fall through and
      // forward the event anyway; the downstream workflow executor is the
      // idempotency authority. If the read succeeds and reports a hit,
      // skip forwarding.
      let alreadyProcessed = false;
      try {
        alreadyProcessed = await this.opts.dedup.isProcessed(
          this.opts.workflowId,
          txHash,
        );
      } catch (err) {
        logger.warn(
          `[EventListener:${this.opts.workflowId}] dedup isProcessed failed, proceeding: ${formatError(err)}`,
        );
      }
      if (alreadyProcessed) {
        logger.log(
          `[EventListener:${this.opts.workflowId}] ${txHash} already processed`,
        );
        return;
      }

      const args = extractEventArgs(parsed, this.opts.rawEventsAbi);
      const payload = buildEventPayload(log, parsed, args);
      await this.sendToSqs(payload);

      // Mark after the send. A crash between send and mark would re-fire
      // the event on the next reconnect (documented best-effort trade).
      // A mark failure here does not un-send SQS - fine, dedup is best-effort.
      try {
        await this.opts.dedup.markProcessed(this.opts.workflowId, txHash);
      } catch (err) {
        logger.warn(
          `[EventListener:${this.opts.workflowId}] dedup markProcessed failed: ${formatError(err)}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[EventListener:${this.opts.workflowId}] handler error: ${formatError(err)}`,
      );
    }
  }

  private async sendToSqs(payload: unknown): Promise<void> {
    await enqueueWorkflowEventTrigger(this.opts.sqs, this.opts.sqsQueueUrl, {
      workflowId: this.opts.workflowId,
      userId: this.opts.userId,
      triggerData: payload,
    });
    logger.log(`[EventListener:${this.opts.workflowId}] enqueued to SQS`);
  }
}
