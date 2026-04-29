import { createHash } from "node:crypto";
import type { DBAdapter, Where } from "better-auth";

// KEEP-239: better-auth 1.5.6 stores `sessions.token` plaintext, which gives
// any attacker who reads the DB live bearer tokens. Until upstream supports
// `session: { hashToken: true }` we wrap the adapter so the column holds
// sha256(token) while the token returned from `create` (and therefore the
// cookie / bearer payload) remains the raw value the client must present.
//
// Coupled to two undocumented call shapes in better-auth:
//   - createSession passes `data.token` as the raw token on `create`.
//   - findSession / findSessions / updateSession / deleteSession all locate
//     rows via `where: [{ field: "token", value }]` (eq) or `operator: "in"`.
// If either changes upstream, the unit tests in
// tests/unit/auth-session-token-hash.test.ts will fail before the bug ships.

const SESSION_MODEL = "session";
const TOKEN_FIELD = "token";

type CreateArgs = Parameters<DBAdapter["create"]>[0];
type FindOneArgs = Parameters<DBAdapter["findOne"]>[0];
type FindManyArgs = Parameters<DBAdapter["findMany"]>[0];
type CountArgs = Parameters<DBAdapter["count"]>[0];
type UpdateArgs = Parameters<DBAdapter["update"]>[0];
type UpdateManyArgs = Parameters<DBAdapter["updateMany"]>[0];
type DeleteArgs = Parameters<DBAdapter["delete"]>[0];
type DeleteManyArgs = Parameters<DBAdapter["deleteMany"]>[0];

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashTokenWhere(where: Where[] | undefined): Where[] | undefined {
  if (!where) {
    return where;
  }
  return where.map((clause) => {
    if (clause.field !== TOKEN_FIELD) {
      return clause;
    }
    const op = clause.operator ?? "eq";
    if (op === "in" || op === "not_in") {
      const values = clause.value as string[];
      return { ...clause, value: values.map(hashSessionToken) };
    }
    if (typeof clause.value !== "string") {
      return clause;
    }
    return { ...clause, value: hashSessionToken(clause.value) };
  });
}

function hashTokenInUpdate(
  update: Record<string, unknown>
): Record<string, unknown> {
  if (typeof update[TOKEN_FIELD] !== "string") {
    return update;
  }
  return {
    ...update,
    [TOKEN_FIELD]: hashSessionToken(update[TOKEN_FIELD] as string),
  };
}

type AdapterFactory = (...args: never[]) => DBAdapter;

export function wrapWithSessionTokenHash<F extends AdapterFactory>(
  factory: F
): F {
  const wrapped = ((...args: Parameters<F>) => {
    const inner = factory(...args);
    return wrapAdapter(inner);
  }) as F;
  return wrapped;
}

function wrapAdapter(inner: DBAdapter): DBAdapter {
  return {
    ...inner,
    create: ((data: CreateArgs) => {
      const incoming = data.data as Record<string, unknown>;
      if (
        data.model !== SESSION_MODEL ||
        typeof incoming[TOKEN_FIELD] !== "string"
      ) {
        return inner.create(data);
      }
      const rawToken = incoming[TOKEN_FIELD] as string;
      const hashed = {
        ...data,
        data: { ...incoming, [TOKEN_FIELD]: hashSessionToken(rawToken) },
      } as CreateArgs;
      return inner.create(hashed).then((stored) => ({
        ...(stored as Record<string, unknown>),
        [TOKEN_FIELD]: rawToken,
      }));
    }) as DBAdapter["create"],
    findOne: <T>(data: FindOneArgs): Promise<T | null> => {
      if (data.model !== SESSION_MODEL) {
        return inner.findOne<T>(data);
      }
      return inner.findOne<T>({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
      });
    },
    findMany: <T>(data: FindManyArgs): Promise<T[]> => {
      if (data.model !== SESSION_MODEL) {
        return inner.findMany<T>(data);
      }
      return inner.findMany<T>({ ...data, where: hashTokenWhere(data.where) });
    },
    count: (data: CountArgs): Promise<number> => {
      if (data.model !== SESSION_MODEL) {
        return inner.count(data);
      }
      return inner.count({ ...data, where: hashTokenWhere(data.where) });
    },
    update: <T>(data: UpdateArgs): Promise<T | null> => {
      if (data.model !== SESSION_MODEL) {
        return inner.update<T>(data);
      }
      return inner.update<T>({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
        update: hashTokenInUpdate(data.update),
      });
    },
    updateMany: (data: UpdateManyArgs): Promise<number> => {
      if (data.model !== SESSION_MODEL) {
        return inner.updateMany(data);
      }
      return inner.updateMany({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
        update: hashTokenInUpdate(data.update),
      });
    },
    delete: <T>(data: DeleteArgs): Promise<void> => {
      if (data.model !== SESSION_MODEL) {
        return inner.delete<T>(data);
      }
      return inner.delete<T>({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
      });
    },
    deleteMany: (data: DeleteManyArgs): Promise<number> => {
      if (data.model !== SESSION_MODEL) {
        return inner.deleteMany(data);
      }
      return inner.deleteMany({
        ...data,
        where: hashTokenWhere(data.where) ?? [],
      });
    },
  };
}
