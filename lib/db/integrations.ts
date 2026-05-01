import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { truncateAddress } from "@/lib/address-utils";
import {
  getOrganizationWallet,
  organizationHasWallet,
} from "@/lib/para/wallet-helpers";
import {
  findActionById,
  getIntegration as getPluginDefinition,
} from "@/plugins/registry";
import type { IntegrationConfig, IntegrationType } from "../types/integration";
import { db } from "./index";
import { integrations, type NewIntegration } from "./schema";

// Encryption configuration
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const ENCRYPTION_KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";

/**
 * Get or generate encryption key from environment
 * Key should be a 32-byte hex string (64 characters)
 */
function getEncryptionKey(): Buffer {
  const keyHex = process.env[ENCRYPTION_KEY_ENV];

  if (!keyHex) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} environment variable is required for encrypting integration credentials`
    );
  }

  if (keyHex.length !== 64) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must be a 64-character hex string (32 bytes)`
    );
  }

  return Buffer.from(keyHex, "hex");
}

/**
 * Encrypt sensitive data
 * Returns a string in format: iv:authTag:encryptedData (all hex-encoded)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Return format: iv:authTag:ciphertext (all hex)
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt encrypted data
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Encrypt integration config object
 */
function encryptConfig(config: Record<string, unknown>): string {
  return encrypt(JSON.stringify(config));
}

/**
 * Decrypt integration config object
 */
function decryptConfig(encryptedConfig: string): Record<string, unknown> {
  try {
    const decrypted = decrypt(encryptedConfig);
    return JSON.parse(decrypted);
  } catch (error) {
    console.error("Failed to decrypt integration config:", error);
    return {};
  }
}

const DB_SECRET_KEYS = new Set(["password", "url"]);

/**
 * Strip secret fields from a database integration config before sending to clients.
 * For non-database integrations, returns the config unchanged.
 */
export function stripDatabaseSecrets(
  config: IntegrationConfig,
  integrationType: IntegrationType
): IntegrationConfig {
  if (integrationType !== "database") {
    return config;
  }

  const stripped: IntegrationConfig = {};
  for (const key of Object.keys(config)) {
    if (!DB_SECRET_KEYS.has(key)) {
      stripped[key] = config[key];
    }
  }
  return stripped;
}

/**
 * Merge incoming config with existing config, preserving secret fields
 * that were not provided (empty or missing) in the update.
 */
export function mergeDatabaseConfig(
  existingConfig: IntegrationConfig,
  incomingConfig: IntegrationConfig
): IntegrationConfig {
  const merged: IntegrationConfig = { ...existingConfig };
  for (const [key, value] of Object.entries(incomingConfig)) {
    if (DB_SECRET_KEYS.has(key)) {
      if (value !== undefined && value !== "") {
        merged[key] = value;
      }
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export type DecryptedIntegration = {
  id: string;
  userId: string;
  name: string;
  type: IntegrationType;
  config: IntegrationConfig;
  isManaged: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Get all integrations for a user, optionally filtered by type
 * Updated to support organization context
 */
export async function getIntegrations(
  userId: string,
  type?: IntegrationType,
  organizationId?: string | null
): Promise<DecryptedIntegration[]> {
  const conditions = organizationId
    ? [eq(integrations.organizationId, organizationId)]
    : [eq(integrations.userId, userId)];

  if (type) {
    conditions.push(eq(integrations.type, type));
  }

  const results = await db
    .select()
    .from(integrations)
    .where(and(...conditions));

  return results.map((integration) => ({
    ...integration,
    config: decryptConfig(integration.config as string) as IntegrationConfig,
  }));
}

/**
 * Get a single integration by ID
 * Updated to support organization context
 */
export async function getIntegration(
  integrationId: string,
  userId: string,
  organizationId?: string | null
): Promise<DecryptedIntegration | null> {
  const conditions = organizationId
    ? [
        eq(integrations.id, integrationId),
        eq(integrations.organizationId, organizationId),
      ]
    : [eq(integrations.id, integrationId), eq(integrations.userId, userId)];

  const result = await db
    .select()
    .from(integrations)
    .where(and(...conditions))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return {
    ...result[0],
    config: decryptConfig(result[0].config as string) as IntegrationConfig,
  };
}

/**
 * Get a single integration by ID without user check (for system use during workflow execution)
 */
export async function getIntegrationById(
  integrationId: string
): Promise<DecryptedIntegration | null> {
  const result = await db
    .select()
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return {
    ...result[0],
    config: decryptConfig(result[0].config as string) as IntegrationConfig,
  };
}

/**
 * Create a new integration
 * Updated to support organization context
 */
type CreateIntegrationOptions = {
  userId: string;
  name: string;
  type: IntegrationType;
  config: IntegrationConfig;
  organizationId?: string | null;
};

export async function createIntegration(
  options: CreateIntegrationOptions
): Promise<DecryptedIntegration> {
  const { userId, name, type, config, organizationId } = options;
  const encryptedConfig = encryptConfig(config);

  const [result] = await db
    .insert(integrations)
    .values({
      userId,
      name,
      type,
      config: encryptedConfig,
      organizationId,
    })
    .returning();

  return {
    ...result,
    config,
  };
}

/**
 * Build the canonical payload used to create the cosmetic web3 integration
 * row that backs an org's KeeperHub wallet. Shared between the provisioning
 * route (`app/api/user/wallet/route.ts`) and the read-path heal below so the
 * shape can't drift if one site adds a field.
 */
export function buildWalletIntegrationPayload(
  userId: string,
  organizationId: string,
  walletAddress: string
): CreateIntegrationOptions {
  return {
    userId,
    organizationId,
    name: truncateAddress(walletAddress),
    type: "web3",
    config: {},
  };
}

/**
 * Ensure the org's KeeperHub wallet has a backing web3 integration row.
 *
 * Wallet provisioning auto-creates a cosmetic web3 integration alongside the
 * wallet. For orgs whose wallet pre-dates that auto-create code, or whose
 * integration was deleted / migrated, the row can be missing -- which made
 * the Workflow Builder render a misleading "Add Web3 connection" warning
 * even though the wallet itself was working fine.
 *
 * Heals that drift idempotently: if the org has an active wallet but no
 * web3 integration row, create one with the canonical payload. Safe to call
 * from any read path that lists integrations -- after the first call for a
 * given org the row exists and subsequent calls early-return. The userId on
 * a healed row is just the first member to GET after deploy; reads are
 * org-scoped so this is benign.
 */
export async function ensureWalletIntegration(
  userId: string,
  organizationId: string
): Promise<void> {
  const hasWallet = await organizationHasWallet(organizationId);
  if (!hasWallet) {
    return;
  }

  const existing = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.organizationId, organizationId),
        eq(integrations.type, "web3")
      )
    )
    .limit(1);
  if (existing.length > 0) {
    return;
  }

  const wallet = await getOrganizationWallet(organizationId);
  // The existence check above is racy: two concurrent /api/integrations GETs
  // for the same org can both pass it and both insert. The
  // `idx_integrations_org_web3` partial unique index makes the second insert
  // fail with Postgres unique_violation (23505); swallow it and treat as
  // success since the other caller already created the row.
  try {
    await createIntegration(
      buildWalletIntegrationPayload(userId, organizationId, wallet.walletAddress)
    );
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "23505") {
      throw err;
    }
  }
}

/**
 * Update an integration
 * Updated to support organization context
 */
export async function updateIntegration(
  integrationId: string,
  userId: string,
  updates: {
    name?: string;
    config?: IntegrationConfig;
  },
  organizationId?: string | null,
  existingIntegration?: DecryptedIntegration | null
): Promise<DecryptedIntegration | null> {
  const updateData: Partial<NewIntegration> = {
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }

  if (updates.config !== undefined) {
    if (existingIntegration?.type === "database") {
      updateData.config = encryptConfig(
        mergeDatabaseConfig(existingIntegration.config, updates.config)
      );
    } else {
      updateData.config = encryptConfig(updates.config);
    }
  }

  const conditions = organizationId
    ? [
        eq(integrations.id, integrationId),
        eq(integrations.organizationId, organizationId),
      ]
    : [eq(integrations.id, integrationId), eq(integrations.userId, userId)];

  const [result] = await db
    .update(integrations)
    .set(updateData)
    .where(and(...conditions))
    .returning();

  if (!result) {
    return null;
  }

  return {
    ...result,
    config: decryptConfig(result.config as string) as IntegrationConfig,
  };
}

/**
 * Delete an integration
 * Updated to support organization context
 */
export async function deleteIntegration(
  integrationId: string,
  userId: string,
  organizationId?: string | null
): Promise<boolean> {
  const conditions = organizationId
    ? [
        eq(integrations.id, integrationId),
        eq(integrations.organizationId, organizationId),
      ]
    : [eq(integrations.id, integrationId), eq(integrations.userId, userId)];

  const result = await db
    .delete(integrations)
    .where(and(...conditions))
    .returning();

  return result.length > 0;
}

/**
 * Workflow node structure for validation
 */
type WorkflowNodeForValidation = {
  data?: {
    config?: {
      integrationId?: string;
      actionType?: string;
    };
  };
};

/**
 * Check if a node's integration ID should be included for validation
 */
function shouldIncludeIntegrationId(node: WorkflowNodeForValidation): boolean {
  const actionType = node.data?.config?.actionType;

  // No action type - include for validation
  if (!actionType || typeof actionType !== "string") {
    return true;
  }

  const action = findActionById(actionType);

  // Unknown action - include for validation
  if (!action) {
    return true;
  }

  const plugin = getPluginDefinition(action.integration);

  // Only include if plugin requires integration (defaults to true)
  return plugin?.requiresCredentials !== false;
}

/**
 * Extract all integration IDs from workflow nodes
 * Only includes nodes whose actions actually require an integration
 */
export function extractIntegrationIds(
  nodes: WorkflowNodeForValidation[]
): string[] {
  const integrationIds: string[] = [];

  for (const node of nodes) {
    const integrationId = node.data?.config?.integrationId;
    if (!integrationId || typeof integrationId !== "string") {
      continue;
    }

    if (shouldIncludeIntegrationId(node)) {
      integrationIds.push(integrationId);
    }
  }

  return [...new Set(integrationIds)];
}

/**
 * Validate that all integration IDs in workflow nodes either:
 * 1. Belong to the specified user (or organization), or
 * 2. Don't exist (deleted integrations - stale references are allowed)
 *
 * This prevents users from accessing other users' credentials by embedding
 * foreign integration IDs in their workflows, while allowing workflows
 * with references to deleted integrations to still be saved.
 *
 * Updated to support organization context
 *
 * @returns Object with `valid` boolean and optional `invalidIds` array
 */
export async function validateWorkflowIntegrations(
  nodes: WorkflowNodeForValidation[],
  userId: string,
  organizationId?: string | null
): Promise<{ valid: boolean; invalidIds?: string[] }> {
  const integrationIds = extractIntegrationIds(nodes);

  if (integrationIds.length === 0) {
    return { valid: true };
  }

  // Query for ALL integrations with these IDs (regardless of user/org)
  // to check if any belong to other users/orgs
  const existingIntegrations = await db
    .select({
      id: integrations.id,
      userId: integrations.userId,
      organizationId: integrations.organizationId,
    })
    .from(integrations)
    .where(inArray(integrations.id, integrationIds));

  // Find integrations that exist but belong to a different user/org
  // (deleted integrations won't appear here, which is fine)
  const invalidIds = existingIntegrations
    .filter((i) => {
      if (organizationId) {
        // For org workflows, check org membership
        return i.organizationId !== organizationId;
      }
      // For anonymous workflows, check user ownership
      return i.userId !== userId;
    })
    .map((i) => i.id);

  if (invalidIds.length > 0) {
    return { valid: false, invalidIds };
  }

  return { valid: true };
}
