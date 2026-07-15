/**
 * Common shape implemented by every per-workflow listener, regardless of
 * chain family. The reconciler only ever calls start()/stop() through the
 * registry, so this is the entire surface the registry needs to hold an EVM
 * `EventListener` and a `SolanaEventListener` in the same map.
 */
export interface Listener {
  start(): Promise<void>;
  stop(): void;
}
