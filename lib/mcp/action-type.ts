/**
 * Shared "is this actionType a write action" check. Used by both the MCP
 * calldata generator (calldata.ts) and the deep validator
 * (validate-workflow-deep.ts) so the two classifications cannot drift.
 *
 * web3/batch-write-contract is explicitly excluded even though it contains
 * the "write-contract" substring: it has no single contractAddress,
 * abiFunction, or functionArgs, so neither caller can treat it like
 * write-contract/protocol-write without breaking (findFirstWriteActionNode
 * would return a node calldata generation can't encode; the deep validator's
 * ABI-mismatch checks would gate on fields the node doesn't have).
 */
export const BATCH_WRITE_CONTRACT_ACTION_TYPE = "web3/batch-write-contract";

export function isWriteActionType(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  if (actionType === BATCH_WRITE_CONTRACT_ACTION_TYPE) {
    return false;
  }
  return (
    actionType.includes("write-contract") ||
    actionType.includes("protocol-write")
  );
}
