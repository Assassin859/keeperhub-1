import "server-only";
import { decryptExportBundle, generateP256KeyPair } from "@turnkey/crypto";
import { Turnkey } from "@turnkey/sdk-server";
import { ErrorCategory, logSystemError } from "@/lib/logging";

let turnkeyInstance: Turnkey | undefined;

function getTurnkeyClient(): Turnkey {
  if (turnkeyInstance) {
    return turnkeyInstance;
  }

  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;

  if (!(apiPublicKey && apiPrivateKey && organizationId)) {
    throw new Error(
      "TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID must be set"
    );
  }

  turnkeyInstance = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });

  return turnkeyInstance;
}

export type TurnkeyWalletResult = {
  subOrgId: string;
  walletId: string;
  privateKeyId: string;
  walletAddress: string;
};

/**
 * Create a Turnkey sub-organization with an HD wallet for a user.
 * Each KeeperHub organization gets its own Turnkey sub-org for isolation.
 */
export async function createTurnkeyWallet(
  email: string,
  organizationName: string
): Promise<TurnkeyWalletResult> {
  const turnkey = getTurnkeyClient();
  const client = turnkey.apiClient();

  try {
    const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY ?? "";

    const subOrg = await client.createSubOrganization({
      organizationId: process.env.TURNKEY_ORGANIZATION_ID ?? "",
      subOrganizationName: `keeperhub-${organizationName}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: "keeperhub-admin",
          userEmail: email,
          apiKeys: [
            {
              apiKeyName: "keeperhub-server",
              publicKey: apiPublicKey,
              curveType: "API_KEY_CURVE_P256" as const,
            },
          ],
          authenticators: [],
          oauthProviders: [],
        },
      ],
      wallet: {
        walletName: "Default Wallet",
        accounts: [
          {
            curve: "CURVE_SECP256K1",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/60'/0'/0/0",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM",
          },
        ],
      },
    });

    const walletId = subOrg.wallet?.walletId;
    const walletAddress = subOrg.wallet?.addresses?.[0];
    const subOrgId = subOrg.subOrganizationId;

    if (!(walletId && walletAddress && subOrgId)) {
      throw new Error(
        "Turnkey sub-organization creation returned incomplete data"
      );
    }

    return {
      subOrgId,
      walletId,
      privateKeyId: "", // Not needed; export uses wallet address
      walletAddress,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Turnkey] Failed to create wallet",
      error,
      { service: "turnkey" }
    );
    throw error;
  }
}

/**
 * Export a private key from Turnkey using server-side P-256 encryption.
 * The key is encrypted by Turnkey's enclave, decrypted locally on our server.
 * Returns the hex private key string (with 0x prefix).
 */
export async function exportTurnkeyPrivateKey(
  subOrgId: string,
  walletAddress: string
): Promise<string> {
  const turnkey = getTurnkeyClient();
  const client = turnkey.apiClient();

  try {
    const keyPair = generateP256KeyPair();

    const exportResult = await client.exportWalletAccount({
      organizationId: subOrgId,
      address: walletAddress,
      targetPublicKey: keyPair.publicKeyUncompressed,
    });

    if (!exportResult.exportBundle) {
      throw new Error("Turnkey returned empty export bundle");
    }

    const privateKey = await decryptExportBundle({
      exportBundle: exportResult.exportBundle,
      embeddedKey: keyPair.privateKey,
      organizationId: subOrgId,
      keyFormat: "HEXADECIMAL",
      returnMnemonic: false,
    });

    return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Turnkey] Failed to export private key",
      error,
      { service: "turnkey" }
    );
    throw error;
  }
}

/**
 * Initialize a Turnkey ethers signer for transaction signing.
 *
 * Creates a Turnkey client scoped to the sub-organization. The TurnkeySigner
 * SDK path uses the client's defaultOrganizationId (not the config's
 * organizationId), so we must create a client per sub-org.
 */
export function getTurnkeySignerConfig(
  subOrgId: string,
  walletAddress: string
): {
  client: ReturnType<Turnkey["apiClient"]>;
  organizationId: string;
  signWith: string;
} {
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;

  if (!(apiPublicKey && apiPrivateKey)) {
    throw new Error(
      "TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY must be set"
    );
  }

  const turnkey = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: subOrgId,
  });

  return {
    client: turnkey.apiClient(),
    organizationId: subOrgId,
    signWith: walletAddress,
  };
}
