import { ethers } from "ethers";

/**
 * Well-known custom error selectors that appear frequently in contracts
 * but may not be included in the user-provided ABI (e.g. inherited from
 * OpenZeppelin base contracts).
 */
const COMMON_ERROR_FRAGMENTS: string[] = [
  "error Unauthorized()",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error AccessControlBadConfirmation()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
  "error ERC721NonexistentToken(uint256 tokenId)",
  "error ERC721InsufficientApproval(address operator, uint256 tokenId)",
  "error FailedCall()",
  "error InsufficientBalance(uint256 balance, uint256 needed)",
  "error AddressInsufficientBalance(address account)",
  "error ReentrancyGuardReentrantCall()",
  "error InvalidInitialization()",
  "error NotInitializing()",
  "error MathOverflowedMulDiv()",
  "error SafeERC20FailedOperation(address token)",
  "error NotAuthorized()",
  "error InsufficientLiquidity()",
  "error InsufficientBalance()",
  "error InvalidAmount()",
  "error InvalidAddress()",
  "error Expired()",
  "error AlreadyInitialized()",
];

const COMMON_ERRORS_INTERFACE = new ethers.Interface(COMMON_ERROR_FRAGMENTS);

function formatDecodedError(decoded: ethers.ErrorDescription): string {
  if (decoded.args.length === 0) {
    return decoded.name;
  }
  const formattedArgs = decoded.args.map((arg: unknown) =>
    typeof arg === "bigint" ? arg.toString() : String(arg)
  );
  return `${decoded.name}(${formattedArgs.join(", ")})`;
}

/**
 * Attempt to decode revert data from an ethers.js CALL_EXCEPTION error.
 *
 * Tries three strategies in order:
 * 1. Parse against the contract's own ABI (catches contract-specific errors)
 * 2. Parse against common OpenZeppelin/standard error selectors
 * 3. Decode as a standard string revert reason (require("message"))
 *
 * Returns a human-readable string, or undefined if decoding fails entirely.
 */
export function decodeRevertReason(
  error: unknown,
  contractInterface?: ethers.Interface
): string | undefined {
  const revertData = extractRevertData(error);
  if (!revertData || revertData === "0x") {
    return;
  }

  // 1. Try the contract's own ABI
  if (contractInterface) {
    try {
      const decoded = contractInterface.parseError(revertData);
      if (decoded) {
        return formatDecodedError(decoded);
      }
    } catch {
      // Not in this ABI
    }
  }

  // 2. Try common error selectors
  try {
    const decoded = COMMON_ERRORS_INTERFACE.parseError(revertData);
    if (decoded) {
      return formatDecodedError(decoded);
    }
  } catch {
    // Not a known common error
  }

  // 3. Try standard string revert (Error(string))
  try {
    const reason = ethers.AbiCoder.defaultAbiCoder().decode(
      ["string"],
      ethers.dataSlice(revertData, 4)
    );
    if (reason[0]) {
      return String(reason[0]);
    }
  } catch {
    // Not a string revert
  }

  return;
}

/**
 * Build a user-facing error message for a contract call failure.
 *
 * If the revert data can be decoded, produces a message like:
 *   "Contract call failed: Unauthorized()"
 *
 * Otherwise falls back to the raw ethers.js error message.
 */
export function formatContractError(
  error: unknown,
  contractInterface?: ethers.Interface,
  prefix?: string
): string {
  const label = prefix ?? "Contract call failed";

  const decoded = decodeRevertReason(error, contractInterface);
  if (decoded) {
    return `${label}: ${decoded}`;
  }

  const message = error instanceof Error ? error.message : String(error);
  return `${label}: ${message}`;
}

function extractRevertData(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return;
  }
  const err = error as Record<string, unknown>;

  // ethers.js v6 CALL_EXCEPTION puts revert data in .data
  if (typeof err.data === "string" && err.data.startsWith("0x")) {
    return err.data;
  }

  // Some errors nest it under .error
  if (err.error && typeof err.error === "object") {
    return extractRevertData(err.error);
  }

  // Some RPC errors put it in .info.error.data
  if (err.info && typeof err.info === "object") {
    return extractRevertData(err.info);
  }

  return;
}

// ---------------------------------------------------------------------------
// Optional classification layer
//
// Adds a structured `kind` tag to revert decoding so callers (workflow logs,
// step results, UI) can show a friendly section like "Kind: AllowanceExceeded"
// alongside the existing string message. Existing decoders are untouched —
// nothing here changes the output of `decodeRevertReason` or
// `formatContractError`. Use `classifyRevert` opt-in.
// ---------------------------------------------------------------------------

/**
 * Zodiac Roles modifier custom errors. Kept in a separate Interface from the
 * common-OZ list so adding them doesn't change `decodeRevertReason`'s output
 * for callers that don't opt into classification.
 */
const ROLE_ERROR_FRAGMENTS: string[] = [
  "error ConditionViolation(uint8 status, bytes32 paramOrAllowanceKey)",
  "error UnauthorizedAccount(address account)",
  "error UnacceptableMultiSendOffset()",
  "error AlreadyAssigned()",
  "error InvalidArrayConfiguration()",
];

const ROLE_ERRORS_INTERFACE = new ethers.Interface(ROLE_ERROR_FRAGMENTS);

/**
 * Friendly labels for the modifier's `Status` enum (see
 * zodiac-modifier-roles ConditionFlat.sol). Index = enum value.
 */
const ROLES_STATUS_LABELS: readonly string[] = [
  "Ok",
  "DelegateCallNotAllowed",
  "TargetAddressNotAllowed",
  "FunctionNotAllowed",
  "SendNotAllowed",
  "OrViolation",
  "NorViolation",
  "ParameterNotAllowed",
  "ParameterLessThanAllowed",
  "ParameterGreaterThanAllowed",
  "ParameterNotAMatch",
  "NotEveryArrayElementPasses",
  "NoArrayElementPasses",
  "ParameterNotSubsetOfAllowed",
  "BitmaskOverflow",
  "BitmaskNotAllowed",
  "CustomConditionViolation",
  "AllowanceExceeded",
  "CallAllowanceExceeded",
  "EtherAllowanceExceeded",
];

export type RevertKind =
  | {
      kind: "role-condition-violation";
      /** Modifier status enum label, e.g. "AllowanceExceeded" */
      status: string;
      statusCode: number;
      /** Allowance bucket key or parameter hash (interpretation depends on status) */
      paramOrKey: string;
    }
  | { kind: "role-not-authorized"; account?: string }
  | { kind: "erc20-insufficient-balance"; balance: string; needed: string }
  | { kind: "erc20-insufficient-allowance"; allowance: string; needed: string }
  | { kind: "ownable-unauthorized"; account?: string }
  | {
      kind: "access-control-unauthorized";
      account?: string;
      neededRole?: string;
    }
  | { kind: "paused" }
  | { kind: "reentrancy" }
  | { kind: "string-revert"; reason: string }
  | { kind: "contract-custom"; name: string }
  | { kind: "unknown" };

function classifyRoleError(
  decoded: ethers.ErrorDescription
): RevertKind | null {
  if (decoded.name === "ConditionViolation") {
    const statusCode = Number(decoded.args[0]);
    const status = ROLES_STATUS_LABELS[statusCode] ?? `Status${statusCode}`;
    const paramOrKey = String(decoded.args[1]);
    return { kind: "role-condition-violation", status, statusCode, paramOrKey };
  }
  if (decoded.name === "UnauthorizedAccount") {
    return { kind: "role-not-authorized", account: String(decoded.args[0]) };
  }
  return null;
}

function classifyCommonError(
  decoded: ethers.ErrorDescription
): RevertKind | null {
  switch (decoded.name) {
    case "ERC20InsufficientBalance":
      return {
        kind: "erc20-insufficient-balance",
        balance: String(decoded.args[1]),
        needed: String(decoded.args[2]),
      };
    case "ERC20InsufficientAllowance":
      return {
        kind: "erc20-insufficient-allowance",
        allowance: String(decoded.args[1]),
        needed: String(decoded.args[2]),
      };
    case "OwnableUnauthorizedAccount":
      return { kind: "ownable-unauthorized", account: String(decoded.args[0]) };
    case "AccessControlUnauthorizedAccount":
      return {
        kind: "access-control-unauthorized",
        account: String(decoded.args[0]),
        neededRole: String(decoded.args[1]),
      };
    case "EnforcedPause":
    case "ExpectedPause":
      return { kind: "paused" };
    case "ReentrancyGuardReentrantCall":
      return { kind: "reentrancy" };
    case "NotAuthorized":
      return { kind: "role-not-authorized" };
    default:
      return null;
  }
}

/**
 * Classify a revert into a structured `kind` for UI / logs.
 *
 * Tries: contract ABI -> Roles modifier errors -> common OZ errors ->
 * string `Error(string)` revert. Returns `{ kind: "unknown" }` if nothing
 * matches; the caller can still fall back to the raw error message via
 * `formatContractError`.
 *
 * Side-effect free; does not throw.
 */
export function classifyRevert(
  error: unknown,
  contractInterface?: ethers.Interface
): RevertKind {
  const revertData = extractRevertData(error);
  if (!revertData || revertData === "0x") {
    return { kind: "unknown" };
  }

  if (contractInterface) {
    try {
      const decoded = contractInterface.parseError(revertData);
      if (decoded) {
        const common = classifyCommonError(decoded);
        if (common) {
          return common;
        }
        return { kind: "contract-custom", name: decoded.name };
      }
    } catch {
      // not in this ABI
    }
  }

  try {
    const decoded = ROLE_ERRORS_INTERFACE.parseError(revertData);
    if (decoded) {
      const role = classifyRoleError(decoded);
      if (role) {
        return role;
      }
    }
  } catch {
    // not a Roles modifier error
  }

  try {
    const decoded = COMMON_ERRORS_INTERFACE.parseError(revertData);
    if (decoded) {
      const common = classifyCommonError(decoded);
      if (common) {
        return common;
      }
      return { kind: "contract-custom", name: decoded.name };
    }
  } catch {
    // not a known common error
  }

  try {
    const reason = ethers.AbiCoder.defaultAbiCoder().decode(
      ["string"],
      ethers.dataSlice(revertData, 4)
    );
    if (reason[0]) {
      return { kind: "string-revert", reason: String(reason[0]) };
    }
  } catch {
    // not a string revert
  }

  return { kind: "unknown" };
}
