import "server-only";

/**
 * Stub — replaced in GREEN phase.
 * Satisfies TypeScript types for TDD RED commit.
 */
export async function resolveImplementationAddress(
  _contractAddress: string,
  _provider: { getStorage(address: string, slot: string): Promise<string> }
): Promise<string | null> {
  return null;
}
