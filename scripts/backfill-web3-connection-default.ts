/**
 * One-shot backfill: stamp `config.web3Connection = "default"` on every
 * existing web3 write node, and clear the legacy `config.integrationId`
 * that the old IntegrationSelector wrote.
 *
 * Why:
 *   Before this change the per-node Web3 Connection field was cosmetic.
 *   `resolveSignerMode(orgId, chainId)` decided routing regardless of what
 *   the UI showed. The new field is the source of truth; missing it on a
 *   node now produces ambiguity in the picker ("Default" vs unset).
 *
 *   Setting it to "default" preserves the prior routing exactly:
 *   `resolveSignerForNode({ web3Connection: "default", ... })` delegates
 *   to `resolveSignerMode`, which is what every node was already doing.
 *
 *   `integrationId` is cleared because for web3 plugins it never pointed
 *   at a real connection row (the Turnkey EOA isn't stored as an
 *   integration), and leaving stale values would confuse future
 *   reconcile-on-edit logic.
 *
 * Scope:
 *   Only nodes whose action type identifies the four web3 write steps
 *   (`transferFundsStep`, `transferTokenStep`, `approveTokenStep`,
 *   `writeContractStep`). Read-only web3 steps and protocol-action nodes
 *   are out of scope; they don't go through the signer resolver.
 *
 * Usage:
 *   npx tsx scripts/backfill-web3-connection-default.ts         # dry-run
 *   npx tsx scripts/backfill-web3-connection-default.ts --apply # write
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../lib/db/schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });
const dryRun = !process.argv.includes("--apply");

const WEB3_WRITE_ACTIONS = new Set([
  "transferFundsStep",
  "transferTokenStep",
  "approveTokenStep",
  "writeContractStep",
]);

type NodeConfig = {
  actionType?: string;
  web3Connection?: string;
  integrationId?: string;
};

type WorkflowNode = {
  id?: string;
  type?: string;
  data?: {
    config?: NodeConfig;
  };
};

function isWeb3WriteNode(node: WorkflowNode): boolean {
  const actionType = node.data?.config?.actionType;
  if (typeof actionType !== "string") {
    return false;
  }
  return WEB3_WRITE_ACTIONS.has(actionType);
}

function rewriteNodes(nodes: WorkflowNode[]): {
  updated: WorkflowNode[];
  touched: number;
} {
  let touched = 0;
  const updated: WorkflowNode[] = nodes.map((node) => {
    if (!isWeb3WriteNode(node)) {
      return node;
    }
    const config = node.data?.config ?? {};
    const hasConnection = typeof config.web3Connection === "string";
    const hasIntegration = typeof config.integrationId === "string";
    if (hasConnection && !hasIntegration) {
      return node;
    }
    touched += 1;
    const { integrationId, ...rest } = config;
    // integrationId is intentionally dropped; rest spreads the remaining
    // config keys so any unrelated fields (network, contractAddress, ...)
    // pass through unchanged.
    return {
      ...node,
      data: {
        ...node.data,
        config: {
          ...rest,
          web3Connection: rest.web3Connection ?? "default",
        },
      },
    };
  });
  return { updated, touched };
}

async function main(): Promise<void> {
  if (dryRun) {
    console.log("[DRY RUN] No changes will be written.\n");
  }

  const rows = await db
    .select({
      id: schema.workflows.id,
      name: schema.workflows.name,
      nodes: schema.workflows.nodes,
    })
    .from(schema.workflows);

  console.log(`Scanned ${rows.length} workflows.`);

  let workflowsTouched = 0;
  let nodesTouched = 0;

  for (const row of rows) {
    const nodes = row.nodes as WorkflowNode[] | null;
    if (!Array.isArray(nodes)) {
      continue;
    }
    const { updated, touched } = rewriteNodes(nodes);
    if (touched === 0) {
      continue;
    }
    workflowsTouched += 1;
    nodesTouched += touched;
    console.log(
      `  [${row.id}] ${row.name}: rewriting ${touched} web3 write node(s)`
    );
    if (!dryRun) {
      await db
        .update(schema.workflows)
        .set({ nodes: updated })
        .where(eq(schema.workflows.id, row.id));
    }
  }

  console.log(
    `\nSummary: ${workflowsTouched} workflow(s), ${nodesTouched} node(s) ${
      dryRun ? "would be" : "were"
    } updated.`
  );

  await client.end();
}

main().catch((error: unknown) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
