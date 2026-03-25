import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "./connection-utils";
import {
  accounts,
  addressBookEntry,
  addressBookEntryRelations,
  apiKeys,
  chains,
  chainsRelations,
  executionDebt,
  explorerConfigs,
  explorerConfigsRelations,
  integrations,
  mcpOauthClients,
  mcpOauthRefreshTokens,
  organizationApiKeys,
  organizationSubscriptions,
  overageBillingRecords,
  pendingTransactions,
  publicTags,
  sessions,
  tags,
  tagsRelations,
  userRpcPreferences,
  userRpcPreferencesRelations,
  users,
  verifications,
  walletLocks,
  workflowExecutionLogs,
  workflowExecutions,
  workflowExecutionsRelations,
  workflowPublicTags,
  workflowSchedules,
  workflowSchedulesRelations,
  workflows,
} from "./schema";

// Construct schema object for drizzle
const schema = {
  users,
  sessions,
  accounts,
  verifications,
  workflows,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionsRelations,
  workflowSchedules,
  workflowSchedulesRelations,
  apiKeys,
  executionDebt,
  mcpOauthClients,
  mcpOauthRefreshTokens,
  organizationApiKeys,
  organizationSubscriptions,
  overageBillingRecords,
  pendingTransactions,
  publicTags,
  walletLocks,
  workflowPublicTags,
  addressBookEntry,
  addressBookEntryRelations,
  tags,
  tagsRelations,
  integrations,
  chains,
  chainsRelations,
  explorerConfigs,
  explorerConfigsRelations,
  userRpcPreferences,
  userRpcPreferencesRelations,
};

const connectionString = getDatabaseUrl();

// For migrations
export const migrationClient = postgres(connectionString, { max: 1 });

// Use global singleton to prevent connection exhaustion during HMR
const globalForDb = globalThis as unknown as {
  queryClient: ReturnType<typeof postgres> | undefined;
  db: PostgresJsDatabase<typeof schema> | undefined;
};

// For queries - reuse connection in development
const queryClient =
  globalForDb.queryClient ?? postgres(connectionString, { max: 10 });
export const db = globalForDb.db ?? drizzle(queryClient, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.queryClient = queryClient;
  globalForDb.db = db;
}
