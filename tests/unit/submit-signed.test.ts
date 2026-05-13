import type { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import type { RpcOperationType, RpcProviderManager } from "@/lib/rpc/providers";
import { submitSignedTransactionWithFailover } from "@/lib/web3/submit-signed";

type BroadcastOp = (
  provider: ethers.JsonRpcProvider
) => Promise<ethers.TransactionResponse>;

function makeMockTxResponse(hash: string): ethers.TransactionResponse {
  return { hash } as unknown as ethers.TransactionResponse;
}

function makeMockSigner(populatedNonce: number, signedHex: string) {
  const populate = vi.fn().mockImplementation(
    async (tx: ethers.TransactionRequest) =>
      ({
        ...tx,
        nonce: tx.nonce ?? populatedNonce,
      }) as ethers.TransactionLike<string>
  );
  const sign = vi.fn().mockResolvedValue(signedHex);
  return {
    signer: {
      populateTransaction: populate,
      signTransaction: sign,
    } as unknown as ethers.Signer,
    populate,
    sign,
  };
}

function makeMockRpcManager(
  invoke: (op: BroadcastOp) => Promise<ethers.TransactionResponse>
): {
  rpcManager: RpcProviderManager;
  executeWithFailover: ReturnType<typeof vi.fn>;
} {
  const executeWithFailover = vi
    .fn()
    .mockImplementation(
      async (op: BroadcastOp, _operationType: RpcOperationType) => invoke(op)
    );
  return {
    rpcManager: { executeWithFailover } as unknown as RpcProviderManager,
    executeWithFailover,
  };
}

describe("submitSignedTransactionWithFailover", () => {
  const txRequest: ethers.TransactionRequest = {
    to: "0x000000000000000000000000000000000000dEaD",
    data: "0xdeadbeef",
    value: BigInt(0),
    nonce: 42,
    gasLimit: BigInt(21_000),
    maxFeePerGas: BigInt(10_000_000_000),
    maxPriorityFeePerGas: BigInt(1_000_000_000),
    chainId: 1,
  };
  const signedHex = "0xf86c0a8502540be40082520894aabb...";

  it("returns the response from the broadcasting provider on first-try success", async () => {
    const { signer, sign, populate } = makeMockSigner(42, signedHex);
    const broadcastTransaction = vi
      .fn()
      .mockResolvedValue(makeMockTxResponse("0xhash"));
    const provider = {
      broadcastTransaction,
    } as unknown as ethers.JsonRpcProvider;
    const { rpcManager, executeWithFailover } = makeMockRpcManager((op) =>
      op(provider)
    );

    const tx = await submitSignedTransactionWithFailover(
      signer,
      txRequest,
      rpcManager
    );

    expect(tx.hash).toBe("0xhash");
    expect(populate).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).toHaveBeenCalledWith(signedHex);
    expect(executeWithFailover).toHaveBeenCalledWith(
      expect.any(Function),
      "write-broadcast"
    );
  });

  it("signs exactly once even when failover invokes the closure twice", async () => {
    const { signer, sign } = makeMockSigner(42, signedHex);
    const primary = {
      broadcastTransaction: vi
        .fn()
        .mockRejectedValue(new Error("primary down")),
    } as unknown as ethers.JsonRpcProvider;
    const fallback = {
      broadcastTransaction: vi
        .fn()
        .mockResolvedValue(makeMockTxResponse("0xhash")),
    } as unknown as ethers.JsonRpcProvider;
    const { rpcManager } = makeMockRpcManager(async (op) => {
      try {
        return await op(primary);
      } catch {
        return await op(fallback);
      }
    });

    const tx = await submitSignedTransactionWithFailover(
      signer,
      txRequest,
      rpcManager
    );

    expect(tx.hash).toBe("0xhash");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(primary.broadcastTransaction).toHaveBeenCalledWith(signedHex);
    expect(fallback.broadcastTransaction).toHaveBeenCalledWith(signedHex);
  });

  it("uses the populated tx for signing (nonce/gas pinned before broadcast)", async () => {
    const { signer, sign, populate } = makeMockSigner(42, signedHex);
    const broadcastTransaction = vi
      .fn()
      .mockResolvedValue(makeMockTxResponse("0xhash"));
    const provider = {
      broadcastTransaction,
    } as unknown as ethers.JsonRpcProvider;
    const { rpcManager } = makeMockRpcManager((op) => op(provider));

    await submitSignedTransactionWithFailover(signer, txRequest, rpcManager);

    expect(populate).toHaveBeenCalledWith(txRequest);
    const populatedArg = (
      sign.mock.calls[0] as [ethers.TransactionLike<string>]
    )[0];
    expect(populatedArg.nonce).toBe(42);
    expect(populatedArg.maxFeePerGas).toBe(BigInt(10_000_000_000));
  });

  it("propagates terminal failure from executeWithFailover after sign", async () => {
    const { signer, sign } = makeMockSigner(42, signedHex);
    const terminal = new Error("both endpoints failed");
    const { rpcManager } = makeMockRpcManager(() => {
      throw terminal;
    });

    await expect(
      submitSignedTransactionWithFailover(signer, txRequest, rpcManager)
    ).rejects.toBe(terminal);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
