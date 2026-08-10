"use client";

import { type PrimitiveAtom, useAtomValue, useSetAtom } from "jotai";
import { loadable } from "jotai/utils";
import { useCallback } from "react";
import type { Project, Tag } from "@/lib/api-client";
import {
  type OrganizationWithRole,
  organizationsAtom,
  organizationsRefreshAtom,
  projectsAtom,
  projectsRefreshAtom,
  tagsAtom,
  tagsRefreshAtom,
} from "@/lib/atoms/organization";

// Built once at module scope: loadable() returns a new atom each call, so
// building it during render would resubscribe on every render.
const organizationsLoadable = loadable(organizationsAtom);
const projectsLoadable = loadable(projectsAtom);
const tagsLoadable = loadable(tagsAtom);

// One shared instance: a fresh [] on every read would be a new identity each
// render, and any effect depending on the value would never stop firing.
const EMPTY: readonly never[] = [];

type Loaded<T> = {
  data: T[];
  isLoading: boolean;
  /** Reloads for every reader at once. Resolves on request, not on arrival. */
  refetch: () => Promise<void>;
};

function useRefresh(refreshAtom: PrimitiveAtom<number>): () => Promise<void> {
  const setRefresh = useSetAtom(refreshAtom);
  return useCallback((): Promise<void> => {
    setRefresh((value) => value + 1);
    return Promise.resolve();
  }, [setRefresh]);
}

/**
 * `null` is the atom's "not started yet" value, which reads as loading rather
 * than as an empty list. An empty list is a real answer and must not flash.
 */
function read<T>(
  state: { state: string; data?: T[] | null },
  refetch: () => Promise<void>
): Loaded<T> {
  if (state.state === "hasData" && state.data != null) {
    return { data: state.data, isLoading: false, refetch };
  }
  return {
    data: EMPTY as unknown as T[],
    isLoading: state.state !== "hasError",
    refetch,
  };
}

export function useOrganizationsData(): Loaded<OrganizationWithRole> {
  return read(
    useAtomValue(organizationsLoadable),
    useRefresh(organizationsRefreshAtom)
  );
}

export function useProjects(): Loaded<Project> {
  return read(useAtomValue(projectsLoadable), useRefresh(projectsRefreshAtom));
}

export function useTags(): Loaded<Tag> {
  return read(useAtomValue(tagsLoadable), useRefresh(tagsRefreshAtom));
}
