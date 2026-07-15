import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Commitment } from "@solana/web3.js";
import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom";
import { logger } from "../../lib/utils/logger";
import { enqueueWorkflowEventTrigger } from "../../lib/workflow-sqs";
import { buildSolanaEventPayload } from "../chains/solana-event-serializer";
import {
  type AnchorEventDecoder,
  createEventDecoder,
} from "../chains/solana-idl";
import type {
  SolanaProviderManager,
  Unsubscribe,
} from "../chains/solana-provider-manager";
import type { DedupStore } from "./dedup";
import { formatError } from "./format-error";
import type { Listener } from "./types";

/**
 * SolanaEventListener watches one workflow's Solana program for on-chain
 * activity. It mirrors EVM `EventListener` (dedup ordering, jitter, phantom +
 * SQS enqueue) but the source is a slot-tick-driven, cursor-based signature
 * poll instead of a topic-filtered log subscription:
 *
 *   slot tick -> getSignaturesForAddress(programId, {until: lastSig})
 *             -> getTransaction(sig) -> meta.logMessages
 *             -> (typed) Anchor-decode + filter by eventName, or (raw) all txs
 *             -> phantom + SQS
 *
 * Raw vs typed is decided by config: no usable IDL -> raw (fire on any tx,
 * emit logs); IDL + eventName -> typed (fire only when the named event is
 * present, emit decoded fields).
 */

const DEFAULT_JITTER_MS = 10_000;
const DEFAULT_POLL_DEBOUNCE_MS = 2_000;
const MAX_SIGNATURES_PER_TICK = 1_000;

export interface SolanaEventListenerOptions {
  workflowId: string;
  userId: string;
  workflowName: string;
  chainId: number;
  rpcUrl: string;
  fallbackRpcUrl?: string;
  wssUrl: string;
  fallbackWssUrl?: string;
  programId: string;
  commitment: Commitment;
  idl?: string;
  eventName?: string;

  sqs: SQSClient;
  sqsQueueUrl: string;
  dedup: DedupStore;
  providerManager: SolanaProviderManager;

  /** Test hooks: 0 disables jitter/debounce for deterministic runs. */
  jitterMs?: number;
  pollDebounceMs?: number;
}

export class SolanaEventListener implements Listener {
  private readonly opts: SolanaEventListenerOptions;
  private readonly decoder: AnchorEventDecoder | null;
  private unsubscribe: Unsubscribe | null = null;
  private started = false;
  private polling = false;
  private lastPollAt = 0;
  private lastSignature: string | null = null;

  constructor(opts: SolanaEventListenerOptions) {
    this.opts = opts;
    this.decoder = createEventDecoder(opts.idl, opts.workflowId);
    if (opts.eventName && !this.decoder) {
      logger.warn(
        `[SolanaEventListener:${opts.workflowId}] eventName "${opts.eventName}" set but no usable IDL; firing on all program txs (raw mode)`,
      );
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    // Seed the cursor to the latest signature so a cold start does not replay
    // history (mirrors the EVM live-subscription semantics). Best-effort: if
    // seeding fails, the first poll seeds instead.
    await this.seedCursor();

    this.unsubscribe = this.opts.providerManager.subscribeToSlots({
      chainId: this.opts.chainId,
      rpcUrl: this.opts.rpcUrl,
      fallbackRpcUrl: this.opts.fallbackRpcUrl,
      wssUrl: this.opts.wssUrl,
      fallbackWssUrl: this.opts.fallbackWssUrl,
      handler: () => this.onSlotTick(),
    });
    this.started = true;
    logger.log(
      `[SolanaEventListener:${this.opts.workflowId}] started - name="${this.opts.workflowName}" chain=${this.opts.chainId} program=${this.opts.programId} mode=${this.decoder ? "typed" : "raw"}`,
    );
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    logger.log(`[SolanaEventListener:${this.opts.workflowId}] stopped`);
  }

  isStarted(): boolean {
    return this.started;
  }

  private async seedCursor(): Promise<void> {
    try {
      const seed = await this.opts.providerManager.getSignaturesForAddress(
        this.opts.chainId,
        this.opts.programId,
        { limit: 1 },
        this.opts.commitment,
      );
      this.lastSignature = seed[0]?.signature ?? null;
    } catch (err) {
      logger.warn(
        `[SolanaEventListener:${this.opts.workflowId}] cursor seed failed, will seed on first poll: ${formatError(err)}`,
      );
    }
  }

  private onSlotTick(): void {
    const debounce = this.opts.pollDebounceMs ?? DEFAULT_POLL_DEBOUNCE_MS;
    const now = Date.now();
    if (this.polling || now - this.lastPollAt < debounce) {
      return;
    }
    this.lastPollAt = now;
    this.polling = true;
    void this.poll()
      .catch((err) => {
        logger.warn(
          `[SolanaEventListener:${this.opts.workflowId}] poll error: ${formatError(err)}`,
        );
      })
      .finally(() => {
        this.polling = false;
      });
  }

  private async poll(): Promise<void> {
    // No cursor yet (seed failed): seed now and process nothing this pass.
    if (this.lastSignature === null) {
      const seed = await this.opts.providerManager.getSignaturesForAddress(
        this.opts.chainId,
        this.opts.programId,
        { limit: 1 },
        this.opts.commitment,
      );
      this.lastSignature = seed[0]?.signature ?? null;
      return;
    }

    const results = await this.opts.providerManager.getSignaturesForAddress(
      this.opts.chainId,
      this.opts.programId,
      { until: this.lastSignature, limit: MAX_SIGNATURES_PER_TICK },
      this.opts.commitment,
    );
    if (results.length === 0) {
      return;
    }
    if (results.length === MAX_SIGNATURES_PER_TICK) {
      // Cursor advances to the newest signature below; anything older than
      // this page but newer than the previous cursor is dropped. Surface it
      // rather than silently under-delivering on a very busy program.
      logger.warn(
        `[SolanaEventListener:${this.opts.workflowId}] signature page hit the ${MAX_SIGNATURES_PER_TICK} cap; older events in this window may be skipped`,
      );
    }

    // Results are newest-first. Advance the cursor to the newest, then process
    // oldest-first so downstream ordering matches on-chain ordering.
    const newest = results[0].signature;
    for (let i = results.length - 1; i >= 0; i--) {
      const info = results[i];
      if (info.err) {
        // Failed transactions emit no meaningful program events.
        continue;
      }
      await this.processSignature(info.signature, info.slot);
    }
    this.lastSignature = newest;
  }

  private async processSignature(
    signature: string,
    slot: number,
  ): Promise<void> {
    let alreadyProcessed = false;
    try {
      alreadyProcessed = await this.opts.dedup.isProcessed(
        this.opts.workflowId,
        signature,
      );
    } catch (err) {
      logger.warn(
        `[SolanaEventListener:${this.opts.workflowId}] dedup isProcessed failed, proceeding: ${formatError(err)}`,
      );
    }
    if (alreadyProcessed) {
      return;
    }

    const tx = await this.opts.providerManager.getTransaction(
      this.opts.chainId,
      signature,
      this.opts.commitment,
    );
    const logs = tx?.meta?.logMessages ?? [];

    const decodedEvents = this.decoder ? this.decoder.decodeLogs(logs) : [];
    let matchedEvents = decodedEvents;
    if (this.opts.eventName && this.decoder) {
      matchedEvents = decodedEvents.filter(
        (event) => event.name === this.opts.eventName,
      );
      if (matchedEvents.length === 0) {
        // Typed filter: the named event was not emitted in this tx; skip.
        return;
      }
    }

    const maxJitter = this.opts.jitterMs ?? DEFAULT_JITTER_MS;
    if (maxJitter > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * maxJitter),
      );
    }

    const payload = buildSolanaEventPayload({
      programId: this.opts.programId,
      signature,
      slot,
      commitment: this.opts.commitment,
      logs,
      eventName: this.opts.eventName,
      decodedEvents: matchedEvents,
    });
    await this.sendToSqs(payload);

    try {
      await this.opts.dedup.markProcessed(this.opts.workflowId, signature);
    } catch (err) {
      logger.warn(
        `[SolanaEventListener:${this.opts.workflowId}] dedup markProcessed failed: ${formatError(err)}`,
      );
    }
  }

  private async sendToSqs(payload: unknown): Promise<void> {
    const executionId = await createPhantomExecution(
      this.opts.workflowId,
      this.opts.userId,
    );

    try {
      await enqueueWorkflowEventTrigger(this.opts.sqs, this.opts.sqsQueueUrl, {
        executionId,
        workflowId: this.opts.workflowId,
        userId: this.opts.userId,
        triggerData: payload,
      });
    } catch (err) {
      if (executionId) {
        await failPhantomExecution(
          executionId,
          "ES-0001",
          `Solana event trigger failed to dispatch: ${formatError(err)}`,
        );
      }
      throw err;
    }

    logger.log(`[SolanaEventListener:${this.opts.workflowId}] enqueued to SQS`);
  }
}
