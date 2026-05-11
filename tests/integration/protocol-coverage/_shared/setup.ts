/**
 * Setup runner for protocol-coverage tests (KEEP-458).
 *
 * Called from each `coverage.test.ts`'s `beforeAll`. Looks up the persistent
 * test user's Turnkey wallet address from `organization_wallets`, runs the
 * native-gas preflight, then executes the programmatically-built setup
 * workflow. The wallet address is stashed on `SharedCtx` so the read/write
 * runners reuse it without a second DB round-trip.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/db/connection-utils";
import { organization } from "@/lib/db/schema";
import { paraWallets } from "@/lib/db/schema-extensions";
import {
  buildSetupWorkflow,
  toWebhookTriggered,
} from "@/lib/test-data/build-workflow";
import {
  createApiKey,
  createTestWorkflow,
  deleteApiKey,
  deleteTestWorkflow,
  getWorkflowWebhookUrl,
  PERSISTENT_TEST_ORG_SLUG,
  PERSISTENT_TEST_USER_EMAIL,
  waitForWorkflowExecution,
} from "@/tests/utils/db";
import { ensureNativeGas } from "./funding";

export type SharedCtx = {
  apiKey?: string;
  walletAddress?: string;
  workflowIds: string[];
};

export function createSharedCtx(): SharedCtx {
  return { workflowIds: [] };
}

/** Look up the persistent test user's active wallet address. Throws when
 *  the seed hasn't run (or Turnkey provisioning was skipped). */
async function getTestWalletAddress(): Promise<string> {
  const client = postgres(getDatabaseUrl(), { max: 1 });
  try {
    const db = drizzle(client);
    const [row] = await db
      .select({ walletAddress: paraWallets.walletAddress })
      .from(paraWallets)
      .innerJoin(organization, eq(organization.id, paraWallets.organizationId))
      .where(
        and(
          eq(organization.slug, PERSISTENT_TEST_ORG_SLUG),
          eq(paraWallets.isActive, true)
        )
      )
      .limit(1);
    if (!row?.walletAddress) {
      throw new Error(
        `No active wallet for org "${PERSISTENT_TEST_ORG_SLUG}". ` +
          "Run `pnpm db:seed-test-wallet` (with TURNKEY_* env vars in scope) first."
      );
    }
    return row.walletAddress;
  } finally {
    await client.end();
  }
}

export async function runSetup(opts: {
  protocol: string;
  chainId: string;
  ctx: SharedCtx;
}): Promise<void> {
  const { protocol, chainId, ctx } = opts;

  if (!ctx.walletAddress) {
    ctx.walletAddress = await getTestWalletAddress();
  }
  const walletAddress = ctx.walletAddress;

  await ensureNativeGas(chainId, walletAddress);

  const setupWf = toWebhookTriggered(
    buildSetupWorkflow(protocol, chainId, walletAddress)
  );

  if (!ctx.apiKey) {
    ctx.apiKey = await createApiKey(PERSISTENT_TEST_USER_EMAIL);
  }

  const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
    name: setupWf.name,
    description: setupWf.description,
    nodes: setupWf.nodes,
    edges: setupWf.edges,
    triggerType: "webhook",
  });
  ctx.workflowIds.push(workflow.id);

  const baseUrl = process.env.PROTOCOL_E2E_BASE_URL ?? "http://localhost:3000";
  const url = getWorkflowWebhookUrl(workflow.id, baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.apiKey}`,
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(
      `setup webhook ${url} returned ${response.status}: ${await response.text()}`
    );
  }

  const result = await waitForWorkflowExecution(workflow.id, 180_000);
  if (!result || result.status !== "success") {
    throw new Error(
      `setup workflow failed for ${protocol}/${chainId}: ${result?.status ?? "timeout"}${result?.error ? ` - ${result.error}` : ""}`
    );
  }
}

export async function cleanupAll(ctx: SharedCtx): Promise<void> {
  for (const id of ctx.workflowIds) {
    try {
      await deleteTestWorkflow(id);
    } catch (err) {
      console.warn(
        `cleanup: deleteTestWorkflow(${id}) failed: ${(err as Error).message}`
      );
    }
  }
  ctx.workflowIds = [];
  if (ctx.apiKey) {
    try {
      await deleteApiKey(ctx.apiKey);
    } catch (err) {
      console.warn(`cleanup: deleteApiKey failed: ${(err as Error).message}`);
    }
    ctx.apiKey = undefined;
  }
  ctx.walletAddress = undefined;
}
