import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";

/**
 * Sign once, broadcast with RPC failover.
 *
 * Wrapping `signer.sendTransaction` in failover is unsafe because ethers
 * re-populates and re-signs on each call, producing a different signed tx
 * (different gas, possibly stale nonce). Splitting populate -> sign -> broadcast
 * keeps the signed bytes fixed across retries; the tx hash is determined by
 * the signature so broadcasting the same hex to multiple endpoints is
 * idempotent.
 *
 * The returned response is pinned to whichever provider succeeded; `tx.wait()`
 * polls on that provider. Wait-side failover is a separate concern.
 */
export async function submitSignedTransactionWithFailover(
  signer: ethers.Signer,
  txRequest: ethers.TransactionRequest,
  rpcManager: RpcProviderManager
): Promise<ethers.TransactionResponse> {
  const populated = await signer.populateTransaction(txRequest);
  const signedHex = await signer.signTransaction(populated);
  return await rpcManager.executeWithFailover(
    (provider) => provider.broadcastTransaction(signedHex),
    "write-broadcast"
  );
}
