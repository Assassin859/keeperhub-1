/**
 * Executable step function for Database Query action
 *
 * SECURITY PATTERN - External Secret Store:
 * Step fetches credentials using workflow ID reference
 */
import "server-only";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { assertConnectionUrlIsPublic } from "@/lib/db/connection-host-guard";
import {
  getDatabaseErrorMessage,
  getPostgresConnectionOptions,
  type PostgresSslOption,
} from "@/lib/db/connection-utils";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

type DatabaseQueryResult =
  | { success: true; rows: unknown; count: number }
  | { success: false; error: string };

/** Primitive types accepted by postgres.js, plus objects/arrays that get JSON-stringified */
export type SqlParam =
  | null
  | undefined
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | Record<string, unknown>
  | readonly SqlParam[];

export type DatabaseQueryInput = StepInput & {
  integrationId?: string;
  dbQuery?: string;
  query?: string;
  _dbParams?: SqlParam[];
};

function validateInput(input: DatabaseQueryInput): string | null {
  const queryString = input.dbQuery || input.query;

  if (!queryString || queryString.trim() === "") {
    return "SQL query is required";
  }

  return null;
}

function createDatabaseClient(
  normalizedUrl: string,
  ssl: PostgresSslOption
): postgres.Sql {
  return postgres(normalizedUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 20,
    ssl: ssl as false | "require" | "prefer",
  });
}

/** Serialize template-resolved values into types postgres.js can bind directly */
export function serializeSqlParams(
  params: SqlParam[]
): postgres.Serializable[] {
  return params.map((p): postgres.Serializable => {
    if (p === null || p === undefined) {
      return null;
    }
    if (p instanceof Date || p instanceof Uint8Array) {
      return p;
    }
    if (typeof p === "object") {
      return JSON.stringify(p);
    }
    return p;
  });
}

async function executeQuery(
  client: postgres.Sql,
  queryString: string,
  params?: SqlParam[]
): Promise<unknown> {
  if (params && params.length > 0) {
    const serialized = serializeSqlParams(params);
    return await client.unsafe(
      queryString,
      serialized as postgres.ParameterOrJSON<never>[]
    );
  }
  const db = drizzle(client);
  return await db.execute(sql.raw(queryString));
}

async function cleanupClient(client: postgres.Sql | null): Promise<void> {
  if (client) {
    try {
      await client.end();
    } catch {
      // Ignore errors during cleanup
    }
  }
}

/**
 * Database query logic
 */
async function databaseQuery(
  input: DatabaseQueryInput
): Promise<DatabaseQueryResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Authorize as the ORG principal: the org owns the workflow, so credential
  // use is gated on the org's integrations, not the creating user's.
  // `_context.ownerId` is createdBy attribution only.
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  const databaseUrl = credentials.DATABASE_URL;

  if (!databaseUrl) {
    return {
      success: false,
      error:
        "DATABASE_URL is not configured. Please add it in Project Integrations.",
    };
  }

  const { normalizedUrl, ssl } = getPostgresConnectionOptions(
    databaseUrl,
    credentials.DATABASE_SSL_MODE
  );

  try {
    await assertConnectionUrlIsPublic(normalizedUrl);
  } catch (guardError) {
    return {
      success: false,
      error:
        guardError instanceof Error
          ? guardError.message
          : "Host is not allowed: must resolve to a public address",
    };
  }

  const queryString = (input.dbQuery || input.query) as string;
  let client: postgres.Sql | null = null;

  try {
    client = createDatabaseClient(normalizedUrl, ssl);
    const result = await executeQuery(client, queryString, input._dbParams);
    return {
      success: true,
      rows: result,
      count: Array.isArray(result) ? result.length : 0,
    };
  } catch (error) {
    console.error("[Database Query] Raw connection error:", error);
    return {
      success: false,
      error: `Database query failed: ${getDatabaseErrorMessage(error)}`,
    };
  } finally {
    await cleanupClient(client);
  }
}

/**
 * Database Query Step
 * Executes a SQL query against a PostgreSQL database
 */
// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function databaseQueryStep(
  input: DatabaseQueryInput
): Promise<DatabaseQueryResult> {
  "use step";
  return withStepLogging(input, () => databaseQuery(input));
}
databaseQueryStep.maxRetries = 0;
