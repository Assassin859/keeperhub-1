import "server-only";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";

export async function submitSignedSolanaTransactionWithFailover(
  signedBytes: Uint8Array,
  manager: SolanaProviderManager
): Promise<{ signature: string }> {
  try {
    // sendRawTransaction returns the transaction signature as a base58 string —
    // no manual encoding needed on the success path.
    const signature = await manager.executeWithFailover(
      (connection) =>
        connection.sendRawTransaction(signedBytes, {
          skipPreflight: true,
          maxRetries: 0,
        }),
      "write-broadcast"
    );
    return { signature };
  } catch (err) {
    // On any broadcast error - a duplicate submission (failover resends the
    // identical signed bytes and Solana dedups by signature) or a timeout where
    // the RPC accepted the tx but never returned a response - reconcile by
    // deriving the deterministic signature from the signed bytes and checking
    // its on-chain status. Only report success for a confirmed/finalized tx
    // with NO execution error; otherwise rethrow the original error so a
    // genuinely-failed or never-landed broadcast surfaces to the caller.
    const firstSig =
      VersionedTransaction.deserialize(signedBytes).signatures[0];
    if (!firstSig) {
      throw err;
    }
    const signature = bs58.encode(firstSig);

    const statusResult = await manager.executeWithFailover(
      async (connection) => {
        const res = await connection.getSignatureStatuses([signature]);
        return res.value[0];
      },
      "read"
    );

    if (
      statusResult &&
      !statusResult.err &&
      (statusResult.confirmationStatus === "confirmed" ||
        statusResult.confirmationStatus === "finalized")
    ) {
      return { signature };
    }
    throw err;
  }
}
