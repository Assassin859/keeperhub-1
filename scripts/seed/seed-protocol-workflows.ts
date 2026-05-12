/**
 * Seed protocol-coverage workflows into the database (KEEP-458).
 *
 * Reads co-located `TEST_DATA` from each `protocols/<slug>.ts` and inserts
 * one workflow row per (protocol, chain, action, trigger) — plus the setup
 * workflow per (protocol, chain) — owned by the persistent test user.
 *
 * Idempotent: deterministic IDs derived from the tuple mean re-runs are a
 * no-op for already-seeded workflows.
 *
 * Usage:
 *   pnpm tsx scripts/seed/seed-protocol-workflows.ts \
 *     [--protocol=<slug>] [--phase=setup|read|write] \
 *     [--trigger=Manual|Schedule|Webhook|Event|Block] [--user=<email>]
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { member, users, workflows } from "../../lib/db/schema";
import { organizationWallets } from "../../lib/db/schema-extensions";
import "@/protocols";
import {
  buildActionWorkflow,
  buildSetupWorkflow,
  type BuiltWorkflow,
  listCoverageTargets,
  TRIGGER_TYPES,
  type TriggerType,
} from "../../lib/test-data/build-workflow";
import { getProtocol } from "../../lib/protocol-registry";

type Cli = {
  protocol?: string;
  phase?: "setup" | "read" | "write";
  trigger?: TriggerType;
  userEmail: string;
};

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    userEmail:
      process.env.SEED_EMAIL ?? "pr-test-do-not-delete@techops.services",
  };
  for (const arg of argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (!value) {
      continue;
    }
    if (key === "protocol") {
      cli.protocol = value;
    } else if (key === "phase") {
      if (value === "setup" || value === "read" || value === "write") {
        cli.phase = value;
      }
    } else if (key === "trigger") {
      if ((TRIGGER_TYPES as readonly string[]).includes(value)) {
        cli.trigger = value as TriggerType;
      }
    } else if (key === "user") {
      cli.userEmail = value;
    }
  }
  return cli;
}

function deterministicId(parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("/")).digest("hex").slice(0, 12);
  return `proto-${hash}`;
}

async function insertOne(
  db: ReturnType<typeof drizzle>,
  workflow: BuiltWorkflow,
  idParts: string[],
  userId: string,
  organizationId: string | null,
  now: Date
): Promise<boolean> {
  const id = deterministicId(idParts);
  try {
    await db
      .insert(workflows)
      .values({
        id,
        name: workflow.name,
        description: workflow.description,
        userId,
        organizationId,
        // biome-ignore lint/suspicious/noExplicitAny: jsonb
        nodes: workflow.nodes as any[],
        // biome-ignore lint/suspicious/noExplicitAny: jsonb
        edges: workflow.edges as any[],
        visibility: "private",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workflows.id,
        set: {
          name: workflow.name,
          description: workflow.description,
          // biome-ignore lint/suspicious/noExplicitAny: jsonb
          nodes: workflow.nodes as any[],
          // biome-ignore lint/suspicious/noExplicitAny: jsonb
          edges: workflow.edges as any[],
          updatedAt: now,
        },
      });
    return true;
  } catch (err) {
    console.error(
      `  ! ${idParts.join("/")}: insert failed (${(err as Error).message})`
    );
    return false;
  }
}

async function seed(cli: Cli): Promise<void> {
  const client = postgres(getDatabaseUrl(), { max: 1 });
  const db = drizzle(client);

  console.log("Seeding protocol-coverage workflows");
  console.log(`User: ${cli.userEmail}`);

  const userRow = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, cli.userEmail))
    .limit(1);
  if (!userRow[0]) {
    console.error(
      `User "${cli.userEmail}" not found. Run seed-test-wallet.ts first.`
    );
    await client.end();
    process.exit(1);
  }
  const userId = userRow[0].id;

  const memberRow = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  const orgId = memberRow[0]?.organizationId ?? null;

  if (!orgId) {
    console.error(
      `User "${cli.userEmail}" has no organization; cannot resolve a wallet to bake into seeded workflows.`
    );
    await client.end();
    process.exit(1);
  }

  const walletRow = await db
    .select({ walletAddress: organizationWallets.walletAddress })
    .from(organizationWallets)
    .where(
      and(eq(organizationWallets.organizationId, orgId), eq(organizationWallets.isActive, true))
    )
    .limit(1);
  if (!walletRow[0]) {
    console.error(
      `No active wallet for org "${orgId}". Run pnpm db:seed-test-wallet (with TURNKEY_* env vars) first.`
    );
    await client.end();
    process.exit(1);
  }
  const walletAddress = walletRow[0].walletAddress;
  console.log(`Wallet: ${walletAddress}`);

  const targets = listCoverageTargets().filter(
    (t) => !cli.protocol || t.protocolSlug === cli.protocol
  );
  if (targets.length === 0) {
    console.warn(
      `No coverage targets matched (protocol=${cli.protocol ?? "*"})`
    );
    await client.end();
    return;
  }

  const triggerFilter: TriggerType[] = cli.trigger
    ? [cli.trigger]
    : [...TRIGGER_TYPES];

  const now = new Date();
  let inserted = 0;
  let failed = 0;

  for (const target of targets) {
    const { protocolSlug, chainId } = target;
    const protocol = getProtocol(protocolSlug);
    if (!protocol) {
      console.warn(`  ! protocol ${protocolSlug} not registered; skipping`);
      continue;
    }

    if (!cli.phase || cli.phase === "setup") {
      const setupWf = buildSetupWorkflow({
        protocolSlug,
        chainId,
        walletAddress,
      });
      const ok = await insertOne(
        db,
        setupWf,
        ["setup", protocolSlug, chainId],
        userId,
        orgId,
        now
      );
      if (ok) {
        inserted += 1;
      } else {
        failed += 1;
      }
    }

    for (const action of protocol.actions) {
      if (cli.phase && cli.phase !== action.type) {
        continue;
      }
      for (const trigger of triggerFilter) {
        const wf = buildActionWorkflow({
          protocolSlug,
          actionSlug: action.slug,
          chainId,
          trigger,
          walletAddress,
        });
        const ok = await insertOne(
          db,
          wf,
          [action.type, protocolSlug, chainId, action.slug, trigger],
          userId,
          orgId,
          now
        );
        if (ok) {
          inserted += 1;
        } else {
          failed += 1;
        }
      }
    }
  }

  console.log(`Done. ${inserted} workflow row(s); ${failed} failed.`);
  await client.end();
}

seed(parseCli(process.argv));
