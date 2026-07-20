import "server-only";
import { PublicKey } from "@solana/web3.js";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";
import { PolicyBlockedError, TurnkeyUpstreamError } from "./sign";

type TurnkeySignTransactionResult = {
  signedTransaction?: string;
};

type TurnkeyActivityResponse = {
  activity?: {
    status?: string;
    result?: { signTransactionResult?: TurnkeySignTransactionResult };
  };
};

export class TurnkeySolanaSigner implements SolanaTransactionSigner {
  private readonly subOrgId: string;
  private readonly solanaAddress: string; // base58 public key

  constructor(subOrgId: string, solanaAddress: string) {
    this.subOrgId = subOrgId;
    this.solanaAddress = solanaAddress;
  }

  getPublicKey(): Promise<{ toBase58(): string }> {
    return Promise.resolve(new PublicKey(this.solanaAddress));
  }

  async signTransaction(unsignedBytes: Uint8Array): Promise<Uint8Array> {
    // Turnkey's signTransaction expects the unsigned transaction as a hex
    // string (all TRANSACTION_TYPE_* variants), not base64. Passing base64
    // triggers "failed to decode Solana transaction: encoding/hex: invalid byte".
    const unsignedTransaction = Buffer.from(unsignedBytes).toString("hex");
    const client = getTurnkeyClientForOrg(this.subOrgId).apiClient();

    const activity = (await (
      client as unknown as {
        signTransaction: (args: unknown) => Promise<TurnkeyActivityResponse>;
      }
    ).signTransaction({
      signWith: this.solanaAddress,
      type: "TRANSACTION_TYPE_SOLANA",
      unsignedTransaction,
    })) as TurnkeyActivityResponse;

    const status = activity.activity?.status;
    if (status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
      throw new PolicyBlockedError(
        "Turnkey policy blocked the Solana signing activity (CONSENSUS_NEEDED)"
      );
    }
    if (status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new TurnkeyUpstreamError(
        `Turnkey returned status ${status ?? "unknown"} for Solana signTransaction`
      );
    }
    const signed =
      activity.activity?.result?.signTransactionResult?.signedTransaction;
    if (!signed) {
      throw new TurnkeyUpstreamError(
        "signedTransaction missing from Turnkey Solana response"
      );
    }
    // Turnkey returns the signed transaction as hex; decode to Uint8Array
    return Uint8Array.from(Buffer.from(signed, "hex"));
  }
}
