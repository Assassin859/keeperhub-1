"use client";

import { useAtom, useAtomValue } from "jotai";
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DURATION_PRESETS,
  type DurationPresetId,
} from "@/lib/analytics/duration-presets";
import type { NormalizedStatus, RunSource } from "@/lib/analytics/types";
import {
  analyticsDurationFilterAtom,
  analyticsNetworkFiltersAtom,
  analyticsNetworksAtom,
  analyticsSearchAtom,
  analyticsSourceFiltersAtom,
  analyticsStatusFacetsAtom,
  analyticsStatusFiltersAtom,
} from "@/lib/atoms/analytics";
import {
  ChainDisplayProvider,
  useChainDisplay,
} from "@/lib/hooks/use-chain-display";
import { FilterCheckbox, FilterPopover, FilterRadio } from "./filter-popover";

type StatusGroup = {
  key: string;
  label: string;
  members: Array<{ value: NormalizedStatus; label: string }>;
};

// Ordered by how often a reader reaches for them: the healthy case, then what
// is still in flight, then the failures with their three subtypes nested under
// one parent so all of them can be selected in a single click.
const STATUS_GROUPS: StatusGroup[] = [
  {
    key: "success",
    label: "Success",
    members: [{ value: "success", label: "Success" }],
  },
  {
    key: "in-flight",
    label: "In flight",
    members: [
      { value: "pending", label: "Pending" },
      { value: "running", label: "Running" },
    ],
  },
  {
    key: "errors",
    label: "Errors",
    members: [
      { value: "error", label: "User" },
      { value: "external_error", label: "External" },
      { value: "system_error", label: "System" },
    ],
  },
  {
    key: "cancelled",
    label: "Cancelled",
    members: [{ value: "cancelled", label: "Cancelled" }],
  },
  {
    key: "skipped",
    label: "Skipped",
    members: [{ value: "skipped", label: "Skipped" }],
  },
];

const SOURCE_OPTIONS: Array<{ value: RunSource; label: string }> = [
  { value: "workflow", label: "Workflow" },
  { value: "direct", label: "Direct" },
];

const SEARCH_DEBOUNCE_MS = 300;

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function StatusFilter(): ReactNode {
  const [statuses, setStatuses] = useAtom(analyticsStatusFiltersAtom);
  const facets = useAtomValue(analyticsStatusFacetsAtom);

  const toggleMember = useCallback(
    (value: NormalizedStatus): void => {
      setStatuses((current) => toggle(current, value));
    },
    [setStatuses]
  );

  const toggleGroup = useCallback(
    (group: StatusGroup): void => {
      const members = group.members.map((member) => member.value);
      setStatuses((current) => {
        const allOn = members.every((value) => current.includes(value));
        if (allOn) {
          return current.filter((value) => !members.includes(value));
        }
        return [...new Set([...current, ...members])];
      });
    },
    [setStatuses]
  );

  const clear = useCallback((): void => setStatuses([]), [setStatuses]);

  return (
    <FilterPopover
      label="Status"
      onClear={clear}
      selectedCount={statuses.length}
    >
      {STATUS_GROUPS.map((group) => {
        const members = group.members.map((member) => member.value);
        const selected = members.filter((value) => statuses.includes(value));
        const groupCount = members.reduce(
          (sum, value) => sum + (facets[value] ?? 0),
          0
        );
        return (
          <div key={group.key}>
            <FilterCheckbox
              checked={selected.length === members.length}
              count={groupCount}
              indeterminate={
                selected.length > 0 && selected.length < members.length
              }
              label={group.label}
              onToggle={() => toggleGroup(group)}
            />
            {group.members.length > 1 &&
              group.members.map((member) => (
                <FilterCheckbox
                  checked={statuses.includes(member.value)}
                  count={facets[member.value] ?? 0}
                  indented
                  key={member.value}
                  label={member.label}
                  onToggle={() => toggleMember(member.value)}
                />
              ))}
          </div>
        );
      })}
    </FilterPopover>
  );
}

function SourceFilter(): ReactNode {
  const [sources, setSources] = useAtom(analyticsSourceFiltersAtom);
  const clear = useCallback((): void => setSources([]), [setSources]);

  return (
    <FilterPopover
      label="Source"
      onClear={clear}
      selectedCount={sources.length}
    >
      {SOURCE_OPTIONS.map((option) => (
        <FilterCheckbox
          checked={sources.includes(option.value)}
          key={option.value}
          label={option.label}
          onToggle={() =>
            setSources((current) => toggle(current, option.value))
          }
        />
      ))}
    </FilterPopover>
  );
}

function NetworkFilter(): ReactNode {
  const [networks, setNetworks] = useAtom(analyticsNetworkFiltersAtom);
  const breakdown = useAtomValue(analyticsNetworksAtom);
  const chains = useChainDisplay();
  const clear = useCallback((): void => setNetworks([]), [setNetworks]);

  // Chains the window actually saw, busiest first. A chain with no runs in the
  // window is not an option, because selecting it could only return nothing.
  const options = useMemo(
    () =>
      [...breakdown]
        .sort((a, b) => b.executionCount - a.executionCount)
        .map((entry) => ({
          value: entry.network,
          label: chains.name(entry.network),
          count: entry.executionCount,
        })),
    [breakdown, chains]
  );

  return (
    <FilterPopover
      label="Network"
      onClear={clear}
      selectedCount={networks.length}
    >
      {options.length === 0 ? (
        <p className="px-2 py-3 text-center text-muted-foreground text-xs">
          No networks in this period
        </p>
      ) : (
        options.map((option) => (
          <FilterCheckbox
            checked={networks.includes(option.value)}
            count={option.count}
            key={option.value}
            label={option.label}
            onToggle={() =>
              setNetworks((current) => toggle(current, option.value))
            }
          />
        ))
      )}
    </FilterPopover>
  );
}

function DurationFilter(): ReactNode {
  const [duration, setDuration] = useAtom(analyticsDurationFilterAtom);
  const clear = useCallback((): void => setDuration(null), [setDuration]);

  const select = useCallback(
    (id: DurationPresetId): void => {
      setDuration((current) => (current === id ? null : id));
    },
    [setDuration]
  );

  return (
    <FilterPopover
      label="Duration"
      onClear={clear}
      selectedCount={duration ? 1 : 0}
    >
      {DURATION_PRESETS.map((preset) => (
        <FilterRadio
          checked={duration === preset.id}
          key={preset.id}
          label={preset.label}
          onSelect={() => select(preset.id)}
        />
      ))}
    </FilterPopover>
  );
}

function SearchBox(): ReactNode {
  const [search, setSearch] = useAtom(analyticsSearchAtom);
  const [draft, setDraft] = useState(search);
  const pushed = useRef(search);

  // Typing narrows a server-side query now, so hold the keystrokes back until
  // the reader pauses rather than refetching the listing on every character.
  useEffect(() => {
    if (draft === search) {
      return;
    }
    const timer = setTimeout(() => {
      pushed.current = draft;
      setSearch(draft);
    }, SEARCH_DEBOUNCE_MS);
    return (): void => clearTimeout(timer);
  }, [draft, search, setSearch]);

  // Someone else cleared the term (the chip, or Clear all), so follow it.
  useEffect(() => {
    if (search !== pushed.current) {
      pushed.current = search;
      setDraft(search);
    }
  }, [search]);

  return (
    <div className="relative w-56">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="h-8 pl-9 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search name or run id..."
        value={draft}
      />
    </div>
  );
}

/**
 * One control to drop every narrowing at once. The dropdown triggers already
 * show what is selected, so there is no chip row restating it; this is only the
 * escape hatch out of a combination.
 */
function ClearAllButton(): ReactNode {
  const [statuses, setStatuses] = useAtom(analyticsStatusFiltersAtom);
  const [sources, setSources] = useAtom(analyticsSourceFiltersAtom);
  const [networks, setNetworks] = useAtom(analyticsNetworkFiltersAtom);
  const [duration, setDuration] = useAtom(analyticsDurationFilterAtom);
  const [search, setSearch] = useAtom(analyticsSearchAtom);

  const clearAll = useCallback((): void => {
    setStatuses([]);
    setSources([]);
    setNetworks([]);
    setDuration(null);
    setSearch("");
  }, [setStatuses, setSources, setNetworks, setDuration, setSearch]);

  const active =
    statuses.length > 0 ||
    sources.length > 0 ||
    networks.length > 0 ||
    duration !== null ||
    search.trim().length > 0;

  if (!active) {
    return null;
  }

  return (
    <Button
      className="h-8 px-2 text-muted-foreground text-xs"
      onClick={clearAll}
      size="sm"
      variant="ghost"
    >
      Clear all
    </Button>
  );
}

export function RunsFilters(): ReactNode {
  return (
    <ChainDisplayProvider>
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox />
        <div className="h-5 w-px bg-border" />
        <StatusFilter />
        <NetworkFilter />
        <DurationFilter />
        <SourceFilter />
        <ClearAllButton />
      </div>
    </ChainDisplayProvider>
  );
}
