import { createHash } from "node:crypto";
import { type Commitment, PublicKey } from "@solana/web3.js";
import type { NetworkConfig, NetworksMap, RawWorkflow } from "../../lib/types";
import { logger } from "../../lib/utils/logger";
import { buildEventAbi } from "../chains/event-serializer";
import type { AbiEvent } from "../chains/validation";
import type {
  EvmWorkflowRegistration,
  SolanaWorkflowRegistration,
  WorkflowRegistration,
} from "./registry";

const VALID_COMMITMENTS: ReadonlySet<string> = new Set([
  "processed",
  "confirmed",
  "finalized",
]);

/**
 * Maps the KeeperHub API workflow response shape into a WorkflowRegistration
 * suitable for ListenerRegistry.add(). Returns null for workflows that are
 * malformed (missing nodes, bad ABI JSON, unknown chainId). Callers should
 * skip null-returning workflows rather than throw.
 *
 * The input type (`RawWorkflow` from lib/types) has every field optional to
 * reflect that the KeeperHub API response is not runtime-validated; the
 * defensive per-field checks below are load-bearing, not dead-code.
 *
 * Extracted from main.ts so it can be unit-tested in isolation.
 */

export function buildRegistration(
  workflow: RawWorkflow,
  networks: NetworksMap,
): WorkflowRegistration | null {
  const workflowId = typeof workflow.id === "string" ? workflow.id : null;
  if (!workflowId) {
    logger.warn("[workflow-mapper] workflow missing id; skipping");
    return null;
  }

  const node = workflow.nodes?.[0];
  if (!node?.data?.config) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} has no node config; skipping`,
    );
    return null;
  }
  const config = node.data.config;

  const chainIdStr = typeof config.network === "string" ? config.network : null;
  if (!chainIdStr) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} has no chainId in node.data.config.network; skipping`,
    );
    return null;
  }
  const chainId = Number(chainIdStr);
  if (!Number.isFinite(chainId)) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chainId "${chainIdStr}" is not numeric; skipping`,
    );
    return null;
  }
  const network = networks[chainId];
  if (!network) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} references unknown chainId ${chainId}; skipping`,
    );
    return null;
  }

  // Solana chains use a fundamentally different watch model (programId +
  // signature cursor + slot subscription, no ABI/topics). Branch before any
  // EVM-specific field checks.
  if (network.chainType === "solana") {
    return buildSolanaRegistration(workflow, workflowId, chainId, network);
  }

  // The DB column `chains.default_primary_wss` is nullable, but
  // `NetworkConfig.defaultPrimaryWss` is typed `string`. Treat it as
  // `string | null | undefined` at runtime: an HTTP URL or empty string
  // pasted into this column would otherwise reach
  // `new ethers.WebSocketProvider(...)` and trigger an `eth_subscribe`
  // rejection that ethers' SocketSubscriber.start() leaves uncaught,
  // crashing the pod.
  const wssUrl: unknown = network.defaultPrimaryWss;
  if (typeof wssUrl !== "string" || wssUrl.length === 0) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chain ${chainId} has no defaultPrimaryWss; skipping`,
    );
    return null;
  }
  if (!(wssUrl.startsWith("wss://") || wssUrl.startsWith("ws://"))) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chain ${chainId} defaultPrimaryWss is not a WebSocket URL ("${wssUrl}"); skipping`,
    );
    return null;
  }

  // Fallback is optional. Same nullable-DB-column caveat as primary: the
  // type says `string` but rows can be null/empty. A bad fallback (wrong
  // scheme, empty) is logged and dropped rather than failing the whole
  // workflow; the listener still runs on primary alone.
  const rawFallbackWssUrl: unknown = network.defaultFallbackWss;
  let fallbackWssUrl: string | undefined;
  if (typeof rawFallbackWssUrl === "string" && rawFallbackWssUrl.length > 0) {
    if (
      rawFallbackWssUrl.startsWith("wss://") ||
      rawFallbackWssUrl.startsWith("ws://")
    ) {
      fallbackWssUrl = rawFallbackWssUrl;
    } else {
      logger.warn(
        `[workflow-mapper] workflow ${workflowId} chain ${chainId} defaultFallbackWss is not a WebSocket URL ("${rawFallbackWssUrl}"); ignoring fallback`,
      );
    }
  }

  const contractAddress =
    typeof config.contractAddress === "string" ? config.contractAddress : null;
  if (!contractAddress) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} missing contractAddress; skipping`,
    );
    return null;
  }

  const eventName =
    typeof config.eventName === "string" ? config.eventName : null;
  if (!eventName) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} missing eventName; skipping`,
    );
    return null;
  }

  const abiRaw =
    typeof config.contractABI === "string" ? config.contractABI : null;
  if (!abiRaw) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} missing contractABI; skipping`,
    );
    return null;
  }
  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abiRaw);
  } catch (err) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} has invalid contractABI JSON: ${String(err)}; skipping`,
    );
    return null;
  }
  if (!Array.isArray(parsedAbi)) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} contractABI is not an array; skipping`,
    );
    return null;
  }
  const rawEventsAbi = (parsedAbi as AbiEvent[]).filter(
    (entry) => entry?.type === "event",
  );
  if (rawEventsAbi.length === 0) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} contractABI contains no events; skipping`,
    );
    return null;
  }
  const eventsAbiStrings = rawEventsAbi.map(buildEventAbi);

  const userId = typeof workflow.userId === "string" ? workflow.userId : "";
  const workflowName = typeof workflow.name === "string" ? workflow.name : "";

  const registration: Omit<EvmWorkflowRegistration, "configHash"> = {
    kind: "evm",
    workflowId,
    userId,
    workflowName,
    chainId,
    wssUrl,
    fallbackWssUrl,
    contractAddress,
    eventName,
    eventsAbiStrings,
    rawEventsAbi,
  };
  return {
    ...registration,
    configHash: hashRegistration(registration),
  };
}

/**
 * Maps a Solana Event workflow into a SolanaWorkflowRegistration. Returns null
 * (skip) for any malformed field, mirroring the EVM path's skip-and-log
 * behaviour. Requires a valid base58 programId and a WSS URL (the slot
 * subscription's block-tick); IDL/eventName are optional (absent -> raw mode).
 */
function buildSolanaRegistration(
  workflow: RawWorkflow,
  workflowId: string,
  chainId: number,
  network: NetworkConfig,
): SolanaWorkflowRegistration | null {
  const config = workflow.nodes?.[0]?.data?.config;
  const programId =
    typeof config?.programId === "string" ? config.programId : null;
  if (!programId) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} missing programId; skipping`,
    );
    return null;
  }
  try {
    // Throws on non-base58 / wrong-length input.
    new PublicKey(programId);
  } catch {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} programId "${programId}" is not a valid base58 address; skipping`,
    );
    return null;
  }

  const rpcUrl: unknown = network.defaultPrimaryRpc;
  if (typeof rpcUrl !== "string" || rpcUrl.length === 0) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chain ${chainId} has no defaultPrimaryRpc; skipping`,
    );
    return null;
  }

  const wssUrl: unknown = network.defaultPrimaryWss;
  if (typeof wssUrl !== "string" || wssUrl.length === 0) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chain ${chainId} has no defaultPrimaryWss (required for slot subscription); skipping`,
    );
    return null;
  }
  if (!(wssUrl.startsWith("wss://") || wssUrl.startsWith("ws://"))) {
    logger.warn(
      `[workflow-mapper] workflow ${workflowId} chain ${chainId} defaultPrimaryWss is not a WebSocket URL ("${wssUrl}"); skipping`,
    );
    return null;
  }

  const rawFallbackRpc: unknown = network.defaultFallbackRpc;
  const fallbackRpcUrl =
    typeof rawFallbackRpc === "string" && rawFallbackRpc.length > 0
      ? rawFallbackRpc
      : undefined;

  const rawFallbackWss: unknown = network.defaultFallbackWss;
  let fallbackWssUrl: string | undefined;
  if (typeof rawFallbackWss === "string" && rawFallbackWss.length > 0) {
    if (
      rawFallbackWss.startsWith("wss://") ||
      rawFallbackWss.startsWith("ws://")
    ) {
      fallbackWssUrl = rawFallbackWss;
    } else {
      logger.warn(
        `[workflow-mapper] workflow ${workflowId} chain ${chainId} defaultFallbackWss is not a WebSocket URL ("${rawFallbackWss}"); ignoring fallback`,
      );
    }
  }

  const commitment: Commitment = VALID_COMMITMENTS.has(config?.commitment ?? "")
    ? (config?.commitment as Commitment)
    : "confirmed";
  const idl = typeof config?.idl === "string" ? config.idl : undefined;
  const eventName =
    typeof config?.eventName === "string" ? config.eventName : undefined;

  const userId = typeof workflow.userId === "string" ? workflow.userId : "";
  const workflowName = typeof workflow.name === "string" ? workflow.name : "";

  const registration: Omit<SolanaWorkflowRegistration, "configHash"> = {
    kind: "solana",
    workflowId,
    userId,
    workflowName,
    chainId,
    rpcUrl,
    fallbackRpcUrl,
    wssUrl,
    fallbackWssUrl,
    programId,
    commitment,
    idl,
    eventName,
  };
  return {
    ...registration,
    configHash: hashSolanaRegistration(registration),
  };
}

/**
 * Content hash over the fields that affect listener behaviour. Used by the
 * reconciler to detect config changes (contract address swap, event name
 * rename, ABI update, user reassignment) and restart the listener. Excludes
 * `workflowId` (the lookup key) and `workflowName` (cosmetic).
 *
 * Stable across JSON round-trips because the input shape is fixed by
 * buildRegistration and all values are primitives or arrays of primitives.
 */
export function hashRegistration(
  reg: Omit<EvmWorkflowRegistration, "configHash">,
): string {
  const canonical = JSON.stringify({
    chainId: reg.chainId,
    wssUrl: reg.wssUrl,
    fallbackWssUrl: reg.fallbackWssUrl ?? null,
    contractAddress: reg.contractAddress,
    eventName: reg.eventName,
    eventsAbiStrings: reg.eventsAbiStrings,
    userId: reg.userId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Content hash over the Solana listener-affecting fields. The reconciler uses
 * it to restart a listener when the program, endpoints, commitment, IDL, or
 * event filter change. Excludes workflowId (lookup key) and workflowName.
 */
export function hashSolanaRegistration(
  reg: Omit<SolanaWorkflowRegistration, "configHash">,
): string {
  const canonical = JSON.stringify({
    chainId: reg.chainId,
    rpcUrl: reg.rpcUrl,
    fallbackRpcUrl: reg.fallbackRpcUrl ?? null,
    wssUrl: reg.wssUrl,
    fallbackWssUrl: reg.fallbackWssUrl ?? null,
    programId: reg.programId,
    commitment: reg.commitment,
    idl: reg.idl ?? null,
    eventName: reg.eventName ?? null,
    userId: reg.userId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
