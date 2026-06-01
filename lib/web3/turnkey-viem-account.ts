import "server-only";
import type {
  Address,
  AuthorizationRequest,
  Hex,
  LocalAccount,
  SignableMessage,
  SignedAuthorization,
} from "viem";
import {
  hashAuthorization,
  hashMessage,
  hashTypedData,
  serializeTransaction,
} from "viem/utils";
import { toChecksumAddress } from "@/lib/address-utils";
import type { OrganizationWallet } from "@/lib/db/schema";
import { getTurnkeySignerConfig } from "@/lib/turnkey/turnkey-client";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";

function parseSignature(
  r: string,
  s: string,
  v: string
): {
  r: Hex;
  s: Hex;
  v: bigint;
} {
  const rHex = (r.startsWith("0x") ? r : `0x${r}`) as Hex;
  const sHex = (s.startsWith("0x") ? s : `0x${s}`) as Hex;
  const vBigInt = BigInt(`0x${v}`);
  const normalizedV = vBigInt < BigInt(27) ? vBigInt + BigInt(27) : vBigInt;
  return { r: rHex, s: sHex, v: normalizedV };
}

async function signHashWithTurnkey(
  client: ReturnType<typeof getTurnkeySignerConfig>["client"],
  signWith: string,
  organizationId: string,
  hash: Hex
): Promise<{ r: Hex; s: Hex; v: bigint }> {
  const cleanHash = hash.startsWith("0x") ? hash.slice(2) : hash;
  const result = await client.signRawPayload({
    organizationId,
    signWith,
    payload: cleanHash,
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NO_OP",
  });

  return parseSignature(result.r, result.s, result.v);
}

function combineSignature(sig: { r: Hex; s: Hex; v: bigint }): Hex {
  const r = sig.r.startsWith("0x") ? sig.r.slice(2) : sig.r;
  const s = sig.s.startsWith("0x") ? sig.s.slice(2) : sig.s;
  const v = sig.v.toString(16).padStart(2, "0");
  return `0x${r}${s}${v}` as Hex;
}

/**
 * Creates a viem LocalAccount backed by Turnkey signing.
 *
 * Used as the `owner` for permissionless.js smart account clients to enable
 * EIP-7702 authorization signing and ERC-4337 user operation signing.
 */
export async function createTurnkeyViemAccount(
  organizationId: string
): Promise<{ account: LocalAccount; walletRecord: OrganizationWallet }> {
  const walletRecord = await getOrganizationWallet(organizationId);

  if (!walletRecord.turnkeySubOrgId) {
    throw new Error("Wallet missing Turnkey sub-organization ID");
  }

  const config = getTurnkeySignerConfig(
    walletRecord.turnkeySubOrgId,
    toChecksumAddress(walletRecord.walletAddress)
  );

  const address = walletRecord.walletAddress as Address;

  const account: LocalAccount = {
    address,
    publicKey: "0x" as Hex,
    source: "turnkey" as string,
    type: "local",

    async sign({ hash }: { hash: Hex }): Promise<Hex> {
      const sig = await signHashWithTurnkey(
        config.client,
        config.signWith,
        config.organizationId,
        hash
      );
      return combineSignature(sig);
    },

    async signMessage({ message }: { message: SignableMessage }): Promise<Hex> {
      const hash = hashMessage(message);
      const sig = await signHashWithTurnkey(
        config.client,
        config.signWith,
        config.organizationId,
        hash
      );
      return combineSignature(sig);
    },

    async signTransaction(transaction, _options?): Promise<Hex> {
      const serialized = serializeTransaction(transaction);
      const cleanPayload = serialized.startsWith("0x")
        ? serialized.slice(2)
        : serialized;
      const result = await config.client.signRawPayload({
        organizationId: config.organizationId,
        signWith: config.signWith,
        payload: cleanPayload,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_KECCAK256",
      });
      const { r, s, v } = parseSignature(result.r, result.s, result.v);
      const yParity = v === BigInt(28) ? 1 : 0;
      return serializeTransaction(transaction, { r, s, yParity });
    },

    // biome-ignore lint/suspicious/noExplicitAny: viem TypedDataDefinition generic is complex
    async signTypedData(parameters: any): Promise<Hex> {
      const hash = hashTypedData(parameters);
      const sig = await signHashWithTurnkey(
        config.client,
        config.signWith,
        config.organizationId,
        hash
      );
      return combineSignature(sig);
    },

    async signAuthorization(
      authorization: AuthorizationRequest
    ): Promise<SignedAuthorization> {
      const hash = hashAuthorization(authorization);
      const { r, s, v } = await signHashWithTurnkey(
        config.client,
        config.signWith,
        config.organizationId,
        hash
      );
      const yParity = v === BigInt(28) ? 1 : 0;
      const contractAddress =
        "address" in authorization
          ? authorization.address
          : authorization.contractAddress;
      return {
        address: contractAddress,
        chainId: authorization.chainId ?? 0,
        nonce: authorization.nonce ?? 0,
        r,
        s,
        yParity,
      } as SignedAuthorization;
    },
  };

  return { account, walletRecord };
}
