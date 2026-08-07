import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { RPC_ENDPOINT_ORIGIN, type RpcEndpointOrigin } from "../types";

/**
 * Failover exhausted on endpoints KeeperHub does not operate, with every
 * attempt ending in a transport failure. `errorClass` names whose fault that
 * is, so the step that catches this can hand the executor an authoritative
 * classification instead of leaving the message classifier to infer one from
 * prose (which reads every `RPC failed ...` string as a platform fault).
 */
export class RpcTransportError extends Error {
  override readonly name = "RpcTransportError" as const;
  readonly errorClass: ExecutionErrorType;

  constructor(message: string, errorClass: ExecutionErrorType) {
    super(message);
    this.errorClass = errorClass;
  }
}

/**
 * The fault domain an RPC failure declares, or undefined for anything that is
 * not a third-party transport failure (the caller keeps its own classification).
 */
export function rpcTransportErrorClass(
  error: unknown
): ExecutionErrorType | undefined {
  return error instanceof RpcTransportError ? error.errorClass : undefined;
}

/**
 * Attribute a transport failure that exhausted every endpoint in `origins`.
 *
 * Undefined when any of them is platform-operated: our own node failing is our
 * problem to answer for, even if a relay failed alongside it. A relay in the
 * mix wins over a customer node because it is the endpoint the routing mode
 * points at.
 */
export function transportFaultDomain(
  origins: readonly RpcEndpointOrigin[]
): ExecutionErrorType | undefined {
  if (origins.length === 0 || origins.includes(RPC_ENDPOINT_ORIGIN.PLATFORM)) {
    return;
  }
  return origins.includes(RPC_ENDPOINT_ORIGIN.RELAY)
    ? ExecutionErrorType.EXTERNAL
    : ExecutionErrorType.USER;
}
