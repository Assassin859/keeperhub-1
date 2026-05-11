/**
 * Shared types + binding helpers for KEEP-458 protocol-coverage test data.
 *
 * Each `protocols/<slug>.ts` co-locates a `TEST_DATA: ProtocolTestData` export
 * alongside its `defineProtocol` definition. The shared builder in
 * `lib/test-data/build-workflow.ts` resolves bindings against the protocol
 * registry + `TOKEN_REGISTRY` + a per-environment wallet address (looked up
 * from `organization_wallets` by the consumer) at call time.
 *
 * Bindings are plain strings or one of four tagged objects:
 *   "DAI"                       -> address-typed input: TOKEN_REGISTRY[chain].DAI.address
 *   "0xabc..."                  -> literal value, passed through verbatim
 *   wallet()                    -> persistent test user's Turnkey wallet address
 *                                  (KEEP-529 made this per-environment; the
 *                                  builder receives it as a parameter)
 *   amount("DAI", "10")         -> wei using DAI's decimals
 *   contract("pool")            -> protocol.contracts.pool.addresses[chain]
 *   native("0.001")             -> wei at 18 decimals
 *
 * The builder uses the action's input type information (from
 * `lib/protocol-registry.ts`) to disambiguate.
 */

import type { TokenSymbol } from "./chain-test-data";

export type WalletBinding = { _wallet: true };
export type AmountBinding = { _amount: { symbol: TokenSymbol; human: string } };
export type ContractBinding = { _contract: { key: string } };
export type NativeBinding = { _native: { human: string } };

export type InputBinding =
  | string
  | WalletBinding
  | AmountBinding
  | ContractBinding
  | NativeBinding;

export function wallet(): WalletBinding {
  return { _wallet: true };
}

export function amount(symbol: TokenSymbol, human: string): AmountBinding {
  return { _amount: { symbol, human } };
}

export function contract(key: string): ContractBinding {
  return { _contract: { key } };
}

export function native(human: string): NativeBinding {
  return { _native: { human } };
}

export function isWalletBinding(v: InputBinding): v is WalletBinding {
  return typeof v === "object" && v !== null && "_wallet" in v;
}

export function isAmountBinding(v: InputBinding): v is AmountBinding {
  return typeof v === "object" && v !== null && "_amount" in v;
}

export function isContractBinding(v: InputBinding): v is ContractBinding {
  return typeof v === "object" && v !== null && "_contract" in v;
}

export function isNativeBinding(v: InputBinding): v is NativeBinding {
  return typeof v === "object" && v !== null && "_native" in v;
}

/** Map of action-input-name -> binding, plus optional virtual `contractAddress`
 *  for actions whose contract is userSpecifiedAddress (Superfluid SuperTokens). */
export type ActionInputBindings = Record<string, InputBinding>;

/** Setup bootstrap per (protocol, chain). */
export type SetupSpec = {
  /** Native gas floor (preflight asserts before the setup workflow runs). */
  minNativeHuman: string;
  /** ERC20 balances the wallet must hold; preflight asserts and throws on shortfall. */
  requiredTokens: Array<{ symbol: TokenSymbol; human: string }>;
  /**
   * Approvals emitted as web3/approve-token nodes inside the setup workflow.
   * `spender` is a regular InputBinding: plain string is treated like any
   * address-typed input (resolved against TOKEN_REGISTRY first, then as a
   * literal 0x address); use `contract("key")` for a protocol contract.
   */
  approvals: Array<{
    token: TokenSymbol;
    spender: InputBinding;
    human: string;
  }>;
  /** Optional protocol-action prep (e.g. wrap fUSDC -> fUSDCx for Superfluid). */
  protocolSteps?: Array<{
    protocol: string;
    action: string;
    inputs: ActionInputBindings;
  }>;
};

export type ProtocolChainTestData = {
  /** When false, builder emits workflows marked _executable:false. */
  enabled?: boolean;
  setup: SetupSpec;
  /** Per-action input bindings keyed by action.slug. */
  actions: Record<string, ActionInputBindings>;
};

/** A protocol's test data, keyed by chainId. */
export type ProtocolTestData = Record<string, ProtocolChainTestData>;
