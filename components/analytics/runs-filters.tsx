"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DURATION_PRESETS,
  type DurationPresetId,
  durationPreset,
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
import {
  FilterCheckbox,
  FilterChip,
  FilterPopover,
  FilterRadio,
} from "./filter-popover";

type StatusGroup = {
  key: string;
  label: string;
  members: Array<{ value: NormalizedStatus; label: string }>;
};

// Errors group first, and its three statuses sit under one parent: ticking
// "Errors" is the whole reason the status filter had to become a multi-select.
const STATUS_GROUPS: StatusGroup[] = [
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

const STATUS_CHIP_LABELS: Record<NormalizedStatus, string> = {
  error: "Error: User",
  external_error: "Error: External",
  system_error: "Error: System",
  success: "Success",
  pending: "Pending",
  running: "Running",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

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

type Chip = { key: string; label: string; onRemove: () => void };

function useFilterChips(): Chip[] {
  const [statuses, setStatuses] = useAtom(analyticsStatusFiltersAtom);
  const [sources, setSources] = useAtom(analyticsSourceFiltersAtom);
  const [networks, setNetworks] = useAtom(analyticsNetworkFiltersAtom);
  const [duration, setDuration] = useAtom(analyticsDurationFilterAtom);
  const [search, setSearch] = useAtom(analyticsSearchAtom);
  const chains = useChainDisplay();

  const chips: Chip[] = [];

  for (const group of STATUS_GROUPS) {
    const members = group.members.map((member) => member.value);
    const selected = members.filter((value) => statuses.includes(value));
    if (selected.length === 0) {
      continue;
    }
    // A fully-ticked group collapses to one chip so "Errors" reads as one
    // decision rather than three.
    if (selected.length === members.length && members.length > 1) {
      chips.push({
        key: group.key,
        label: `${group.label} (${members.length})`,
        onRemove: () =>
          setStatuses((current) =>
            current.filter((value) => !members.includes(value))
          ),
      });
      continue;
    }
    for (const value of selected) {
      chips.push({
        key: value,
        label: STATUS_CHIP_LABELS[value],
        onRemove: () =>
          setStatuses((current) => current.filter((entry) => entry !== value)),
      });
    }
  }

  for (const source of sources) {
    chips.push({
      key: `source-${source}`,
      label: source === "workflow" ? "Workflow" : "Direct",
      onRemove: () =>
        setSources((current) => current.filter((entry) => entry !== source)),
    });
  }

  for (const network of networks) {
    chips.push({
      key: `network-${network}`,
      label: chains.name(network),
      onRemove: () =>
        setNetworks((current) => current.filter((entry) => entry !== network)),
    });
  }

  const preset = durationPreset(duration);
  if (preset) {
    chips.push({
      key: "duration",
      label: preset.label,
      onRemove: () => setDuration(null),
    });
  }

  if (search.trim()) {
    chips.push({
      key: "search",
      label: `"${search.trim()}"`,
      onRemove: () => setSearch(""),
    });
  }

  return chips;
}

function ActiveFilters(): ReactNode {
  const chips = useFilterChips();
  const setStatuses = useSetAtom(analyticsStatusFiltersAtom);
  const setSources = useSetAtom(analyticsSourceFiltersAtom);
  const setNetworks = useSetAtom(analyticsNetworkFiltersAtom);
  const setDuration = useSetAtom(analyticsDurationFilterAtom);
  const setSearch = useSetAtom(analyticsSearchAtom);

  const clearAll = useCallback((): void => {
    setStatuses([]);
    setSources([]);
    setNetworks([]);
    setDuration(null);
    setSearch("");
  }, [setStatuses, setSources, setNetworks, setDuration, setSearch]);

  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <FilterChip
          key={chip.key}
          label={chip.label}
          onRemove={chip.onRemove}
        />
      ))}
      <Button
        className="h-6 px-2 text-xs text-muted-foreground"
        onClick={clearAll}
        size="sm"
        variant="ghost"
      >
        Clear all
      </Button>
    </div>
  );
}

export function RunsFilters(): ReactNode {
  return (
    <ChainDisplayProvider>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox />
          <div className="h-5 w-px bg-border" />
          <StatusFilter />
          <SourceFilter />
          <NetworkFilter />
          <DurationFilter />
        </div>
        <ActiveFilters />
      </div>
    </ChainDisplayProvider>
  );
}
