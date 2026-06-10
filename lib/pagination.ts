/**
 * Shared cursor-based, HATEOAS pagination for list endpoints.
 *
 * Endpoints order by a stable, monotonic key (createdAt, version, ...) and
 * fetch `limit + 1` rows. `buildCursorPage` splits off the page and returns
 * `_links` (self / next / prev) the client follows directly -- no cursor
 * arithmetic on the client. Pagination is bidirectional: `?cursor=` pages
 * forward (older rows), `?before=` pages back (newer rows). Cursors are the
 * opaque, stringified sort key of a boundary row, so this needs no COUNT and
 * is stable under concurrent inserts.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type CursorDirection = "next" | "prev";

export type PageLinks = {
  self: string;
  next: string | null;
  prev: string | null;
};

export type CursorPage<T> = {
  items: T[];
  _links: PageLinks;
};

export type CursorRequest = {
  limit: number;
  cursor: string | null;
  direction: CursorDirection;
};

/** Clamp a raw `?limit=` value into [1, max], falling back when absent/invalid. */
export function parsePageLimit(
  raw: string | null,
  opts?: { fallback?: number; max?: number }
): number {
  const fallback = opts?.fallback ?? DEFAULT_PAGE_SIZE;
  const max = opts?.max ?? MAX_PAGE_SIZE;
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, 1), max);
}

/**
 * Parse limit + cursor + direction from a request URL. A `before` param wins
 * over `cursor` and selects backward (newer) paging; otherwise we page forward
 * (older) from `cursor` (or the start when neither is present).
 */
export function parseCursorRequest(
  url: URL,
  opts?: { fallback?: number; max?: number }
): CursorRequest {
  const limit = parsePageLimit(url.searchParams.get("limit"), opts);
  const before = url.searchParams.get("before");
  if (before) {
    return { limit, cursor: before, direction: "prev" };
  }
  return { limit, cursor: url.searchParams.get("cursor"), direction: "next" };
}

function pageHref(
  url: URL,
  param: "cursor" | "before" | null,
  value?: string
): string {
  const params = new URLSearchParams(url.search);
  params.delete("cursor");
  params.delete("before");
  if (param && value) {
    params.set(param, value);
  }
  const qs = params.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}

/**
 * Slice rows fetched with `limit + 1` into a page and build HATEOAS links.
 *
 * `rows` must be in the query's natural fetch order for the direction:
 * newest-first (DESC) for "next", oldest-first (ASC) for "prev". The returned
 * `items` are always newest-first for display. `getCursor` returns a row's
 * opaque sort key.
 */
export function buildCursorPage<T>(
  rows: T[],
  req: CursorRequest,
  url: URL,
  getCursor: (row: T) => string | number
): CursorPage<T> {
  const hasMore = rows.length > req.limit;
  const sliced = hasMore ? rows.slice(0, req.limit) : rows;
  const items = req.direction === "prev" ? [...sliced].reverse() : sliced;

  const newest = items[0];
  const oldest = items.at(-1);
  const startCursor = newest === undefined ? null : String(getCursor(newest));
  const endCursor = oldest === undefined ? null : String(getCursor(oldest));

  // Forward: more older rows when this page overflowed. Coming from a backward
  // jump, an older page (the one we left) always exists.
  const hasNext = req.direction === "next" ? hasMore : true;
  // Backward: more newer rows when the backward page overflowed. On a forward
  // page, a newer page exists whenever we paged in from a cursor.
  const hasPrev = req.direction === "prev" ? hasMore : req.cursor !== null;

  return {
    items,
    _links: {
      self: pageHref(
        url,
        req.direction === "prev" ? "before" : "cursor",
        req.cursor ?? undefined
      ),
      next: hasNext && endCursor ? pageHref(url, "cursor", endCursor) : null,
      prev:
        hasPrev && startCursor ? pageHref(url, "before", startCursor) : null,
    },
  };
}
