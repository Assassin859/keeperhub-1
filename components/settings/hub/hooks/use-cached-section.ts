"use client";

import { useCallback, useEffect, useState } from "react";
import { useSettingsContext } from "../settings-context";
import { cacheRead, cacheWrite } from "./settings-cache";

type CachedSection<T> = {
  data: T | undefined;
  /** True only the first time, when there is nothing to show yet. */
  loading: boolean;
  refetch: () => Promise<void>;
};

/**
 * Section data that survives leaving the section.
 *
 * A section already visited paints from what it last saw and refreshes behind
 * that, so moving between sections costs a repaint rather than a skeleton.
 * Keys carry the organization, so another organization's data can never be
 * what gets painted, and the settings revision forces a reload when something
 * has changed underneath.
 */
export function useCachedSection<T>(
  key: string | null,
  fetcher: () => Promise<T>
): CachedSection<T> {
  const { revision } = useSettingsContext();
  const [data, setData] = useState<T | undefined>(() => cacheRead<T>(key));

  const load = useCallback(async (): Promise<void> => {
    const next = await fetcher();
    cacheWrite(key, next);
    setData(next);
    // biome-ignore lint/correctness/useExhaustiveDependencies: the fetcher is rebuilt on every render by its callers
  }, [key]);

  useEffect(() => {
    setData(cacheRead<T>(key));
    load().catch(() => undefined);
  }, [key, load, revision]);

  return { data, loading: data === undefined, refetch: load };
}
