"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Page, PageMeta } from "@/lib/pagination";

type UsePaginatedResourceResult<T> = {
  items: T[];
  meta: PageMeta | null;
  page: number;
  setPage: (page: number) => void;
  loading: boolean;
  error: boolean;
  reload: () => void;
};

/**
 * Drives any offset-paginated endpoint that returns a `Page<T>`. Owns the
 * page/items/meta/loading/error state so components don't reimplement it.
 *
 * - `fetchPage(page)` is read through a ref, so callers can pass an inline
 *   closure without retriggering fetches.
 * - `resetKey` identifies the query (filters, target id, open state, ...);
 *   changing it resets to page 1 and refetches.
 * - `enabled` gates fetching (e.g. only while a panel is open).
 */
export function usePaginatedResource<T>(
  fetchPage: (page: number) => Promise<Page<T>>,
  resetKey: string,
  options?: { enabled?: boolean }
): UsePaginatedResourceResult<T> {
  const enabled = options?.enabled ?? true;
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<T[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  // A new query identity always starts from the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the change trigger, not read in the body
  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey/reloadTick are refetch triggers; fetchPage is read via ref
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let active = true;
    setLoading(true);
    setError(false);
    fetchRef
      .current(page)
      .then((res) => {
        if (active) {
          setItems(res.items);
          setMeta(res.meta);
        }
      })
      .catch(() => {
        if (active) {
          setError(true);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [enabled, page, resetKey, reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  return { items, meta, page, setPage, loading, error, reload };
}
