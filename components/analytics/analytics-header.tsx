"use client";

import { useAtom, useAtomValue } from "jotai";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TimeRange } from "@/lib/analytics/types";
import {
  analyticsLastUpdatedAtom,
  analyticsRangeAtom,
} from "@/lib/atoms/analytics";
import { cn } from "@/lib/utils";
import { FilterRadio, ValuePopover } from "./filter-popover";

// `label` is what the trigger shows once chosen, `option` what the list reads.
const RANGE_OPTIONS: Array<{
  value: TimeRange;
  label: string;
  option: string;
}> = [
  { value: "1h", label: "1h", option: "Last hour" },
  { value: "24h", label: "24h", option: "Last 24 hours" },
  { value: "7d", label: "7d", option: "Last 7 days" },
  { value: "30d", label: "30d", option: "Last 30 days" },
];

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

type AnalyticsHeaderProps = {
  onRefetch?: () => Promise<void>;
};

export function AnalyticsHeader({
  onRefetch,
}: AnalyticsHeaderProps): React.ReactNode {
  const [range, setRange] = useAtom(analyticsRangeAtom);
  const lastUpdated = useAtomValue(analyticsLastUpdatedAtom);
  const [timeAgo, setTimeAgo] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);

  // Update the "time ago" display every 5 seconds
  useEffect(() => {
    if (!lastUpdated) {
      return;
    }

    setTimeAgo(formatTimeAgo(lastUpdated));

    const interval = setInterval(() => {
      setTimeAgo(formatTimeAgo(lastUpdated));
    }, 5000);

    return (): void => {
      clearInterval(interval);
    };
  }, [lastUpdated]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (!onRefetch) {
      return;
    }
    setRefreshing(true);
    try {
      await onRefetch();
    } finally {
      setRefreshing(false);
    }
  }, [onRefetch]);

  const handleRangeChange = useCallback(
    (value: TimeRange): void => {
      setRange(value);
    },
    [setRange]
  );

  const rangeLabel =
    RANGE_OPTIONS.find((option) => option.value === range)?.label ?? "Custom";

  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
      </div>

      <div className="flex items-center gap-3">
        <ValuePopover label="Time" value={rangeLabel}>
          {(close) =>
            RANGE_OPTIONS.map((option) => (
              <FilterRadio
                checked={range === option.value}
                key={option.value}
                label={option.option}
                onSelect={() => {
                  handleRangeChange(option.value);
                  close();
                }}
              />
            ))
          }
        </ValuePopover>

        {onRefetch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                disabled={refreshing}
                onClick={() => {
                  handleRefresh().catch(() => {
                    /* errors handled in handleRefresh */
                  });
                }}
                size="icon-sm"
                variant="outline"
              >
                <RefreshCw
                  className={cn("size-4", refreshing && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh data</TooltipContent>
          </Tooltip>
        ) : null}

        {lastUpdated ? (
          <span className="text-xs text-muted-foreground">
            Updated {timeAgo}
          </span>
        ) : null}
      </div>
    </header>
  );
}
