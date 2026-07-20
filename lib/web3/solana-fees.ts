import "server-only";

/**
 * Solana base transaction fee: 5000 lamports per signature.
 *
 * Reserved on top of the transfer amount in Solana balance preflights. Without
 * it a max-balance transfer passes preflight and then fails at inclusion for
 * not covering its own fee.
 *
 * This assumes a single signature, which holds for the transfers that use it:
 * the organization wallet is both fee payer and transfer authority, and
 * creating an associated token account needs no additional signer. A future
 * multi-signer path must multiply by the signature count.
 */
export const SOLANA_BASE_FEE_LAMPORTS = BigInt(5000);
