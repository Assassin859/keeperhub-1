/**
 * Prometheus-backed RPC metrics collectors for EVM and Solana providers.
 *
 * Implements RpcMetricsCollector and SolanaRpcMetricsCollector interfaces
 * from the rpc-provider modules, backed by Prometheus counters and gauges.
 *
 * Also provides an onFailoverStateChange callback that updates the
 * keeperhub_rpc_using_fallback gauge and records failover/recovery events.
 */

import "server-only";

import type { RpcMetricsCollector } from "@/lib/rpc-provider";
import type { SolanaRpcMetricsCollector } from "@/lib/rpc-provider/solana";
import { rpcMetrics } from "./collectors/prometheus";

/**
 * Prometheus-backed RPC metrics collector shared by EVM and Solana providers.
 * Both interfaces are structurally identical, so a single implementation serves both.
 */
const prometheusCollector: RpcMetricsCollector & SolanaRpcMetricsCollector = {
  recordPrimaryAttempt(chain: string): void {
    rpcMetrics.primaryAttempts.inc({ chain });
  },
  recordPrimaryFailure(chain: string): void {
    rpcMetrics.primaryFailures.inc({ chain });
  },
  recordFallbackAttempt(chain: string): void {
    rpcMetrics.fallbackAttempts.inc({ chain });
  },
  recordFallbackFailure(chain: string): void {
    rpcMetrics.fallbackFailures.inc({ chain });
  },
  recordFailoverEvent(chain: string): void {
    rpcMetrics.failoverEvents.inc({ chain });
  },
  recordRecoveryEvent(chain: string): void {
    rpcMetrics.recoveryEvents.inc({ chain });
  },
  recordBothFailed(chain: string): void {
    rpcMetrics.bothFailedEvents.inc({ chain });
    rpcMetrics.healthState.set({ chain }, 2);
  },
  recordSuccess(chain: string, provider: "primary" | "fallback"): void {
    rpcMetrics.healthState.set({ chain }, provider === "primary" ? 0 : 1);
  },
};

export const prometheusRpcMetricsCollector: RpcMetricsCollector =
  prometheusCollector;
export const prometheusSolanaRpcMetricsCollector: SolanaRpcMetricsCollector =
  prometheusCollector;

/**
 * Failover state change callback that updates Prometheus gauge and counters.
 * Pass this as the onFailoverStateChange callback to RpcProviderManager.
 */
export function onRpcFailoverStateChange(
  chain: string,
  isUsingFallback: boolean,
  _reason: "failover" | "recovery"
): void {
  rpcMetrics.currentProvider.set({ chain }, isUsingFallback ? 1 : 0);
}
