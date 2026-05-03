/**
 * Enforce the EIP-1559 invariant maxFeePerGas >= maxPriorityFeePerGas
 * on a fee pair before handing it to a userOperation.
 *
 * Pimlico's getUserOperationGasPrice().fast has been observed on Sepolia
 * returning maxPriorityFeePerGas > maxFeePerGas. Defensive clamp: lift
 * maxFeePerGas to the priority value when violated. The on-chain cost
 * paid is still baseFee + tip, only the cap moves.
 */
export function clampSponsoredFees(fees: {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (fees.maxFeePerGas < fees.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: fees.maxPriorityFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }
  return fees;
}
