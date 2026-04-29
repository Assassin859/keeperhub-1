import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/db");
vi.mock("server-only", () => ({}));

import {
  hashSessionToken,
  wrapWithSessionTokenHash,
} from "@/lib/auth-session-token-hash";
import { sessions, users } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * KEEP-239 integration: exercise the session-token-hashing adapter wrapper
 * against the real drizzleAdapter and a real Postgres database. This catches
 * the failure mode the unit tests cannot: better-auth's drizzle adapter
 * silently changing the call shape (e.g. `field: "token"` → `field: "tokenHash"`)
 * would let unit tests pass while production auth quietly breaks.
 *
 * Skipped when no DATABASE_URL is configured.
 */

const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

describe.skipIf(shouldSkip)("wrapWithSessionTokenHash (integration)", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let testUserId: string;
  // The wrapped adapter we exercise. better-auth's drizzleAdapter returns
  // a factory `(options) => DBAdapter`; calling it with a minimal options
  // object is enough for the operations we use here.
  let adapter: ReturnType<ReturnType<typeof drizzleAdapter>>;

  const createdSessionTokens: string[] = [];

  beforeAll(async () => {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/keeperhub";
    client = postgres(connectionString, { max: 2 });
    db = drizzle(client);

    const factory = wrapWithSessionTokenHash(
      drizzleAdapter(db, {
        provider: "pg",
        schema: { user: users, session: sessions },
      })
    );
    // better-auth options shape is internal; the adapter only needs a
    // non-null object for the operations we use here.
    adapter = factory({} as Parameters<typeof factory>[0]);

    testUserId = `test-${generateId()}`;
    const now = new Date();
    await db.insert(users).values({
      id: testUserId,
      email: `${testUserId}@keep-239-test.local`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    if (!client) {
      return;
    }
    for (const token of createdSessionTokens) {
      await db
        .delete(sessions)
        .where(eq(sessions.token, hashSessionToken(token)));
    }
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
    await client.end({ timeout: 2 });
  });

  it("stores sha256(token) in the DB and round-trips lookups via raw token", async () => {
    const rawToken = `raw-token-${generateId()}`;
    createdSessionTokens.push(rawToken);
    const expiresAt = new Date(Date.now() + 60_000);

    const created = await adapter.create<Record<string, unknown>>({
      model: "session",
      data: {
        id: `sess-${generateId()}`,
        token: rawToken,
        userId: testUserId,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Wrapper restores the raw token in the create return so better-auth
    // can sign the cookie / bearer header with it.
    expect(created.token).toBe(rawToken);

    // The DB column holds the hash, not the raw token.
    const [row] = await db
      .select({ token: sessions.token })
      .from(sessions)
      .where(eq(sessions.id, created.id as string));
    expect(row.token).toBe(hashSessionToken(rawToken));
    expect(row.token).not.toBe(rawToken);

    // findOne via the wrapper, presenting the raw token, finds the row.
    const found = await adapter.findOne<{ id: string; token: string }>({
      model: "session",
      where: [{ field: "token", value: rawToken }],
    });
    expect(found?.id).toBe(created.id);
    // Returned row's token is the stored hash (post-KEEP-239 semantics).
    expect(found?.token).toBe(hashSessionToken(rawToken));

    // A wrong token finds nothing.
    const missing = await adapter.findOne({
      model: "session",
      where: [{ field: "token", value: "not-the-token" }],
    });
    expect(missing).toBeNull();
  });

  it("findMany with operator: in hashes every value", async () => {
    const tokenA = `multi-a-${generateId()}`;
    const tokenB = `multi-b-${generateId()}`;
    createdSessionTokens.push(tokenA, tokenB);
    const expiresAt = new Date(Date.now() + 60_000);

    for (const token of [tokenA, tokenB]) {
      await adapter.create({
        model: "session",
        data: {
          id: `sess-${generateId()}`,
          token,
          userId: testUserId,
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    const rows = await adapter.findMany<{ token: string }>({
      model: "session",
      where: [{ field: "token", value: [tokenA, tokenB], operator: "in" }],
    });
    expect(rows).toHaveLength(2);
    const storedTokens = rows.map((r) => r.token).sort();
    expect(storedTokens).toEqual(
      [hashSessionToken(tokenA), hashSessionToken(tokenB)].sort()
    );
  });

  it("delete by raw token removes the row", async () => {
    const rawToken = `delete-me-${generateId()}`;
    const expiresAt = new Date(Date.now() + 60_000);
    const created = await adapter.create<{ id: string }>({
      model: "session",
      data: {
        id: `sess-${generateId()}`,
        token: rawToken,
        userId: testUserId,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await adapter.delete({
      model: "session",
      where: [{ field: "token", value: rawToken }],
    });

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, created.id));
    expect(row).toBeUndefined();
  });
});
