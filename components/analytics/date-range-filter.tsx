"use client";

import { useAtom, useSetAtom } from "jotai";
import { CalendarDays } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  analyticsCustomEndAtom,
  analyticsCustomStartAtom,
  analyticsRangeAtom,
} from "@/lib/atoms/analytics";
import { cn } from "@/lib/utils";

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long" });

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Exclusive end: the instant after the chosen day, so that day is included. */
function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

type Preset = { key: string; label: string; from: Date; to: Date };

/**
 * Whole calendar months back from this one, which is the shape of the ask:
 * "all of August" rather than "the last 31 days".
 */
function buildPresets(now: Date): Preset[] {
  const presets: Preset[] = [
    { key: "today", label: "Today", from: startOfDay(now), to: endOfDay(now) },
  ];
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  presets.push({
    key: "yesterday",
    label: "Yesterday",
    from: startOfDay(yesterday),
    to: endOfDay(yesterday),
  });

  for (let back = 0; back < 4; back += 1) {
    const first = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const last = new Date(now.getFullYear(), now.getMonth() - back + 1, 0);
    presets.push({
      key: `month-${back}`,
      label: back === 0 ? "This month" : MONTH_LABEL.format(first),
      from: startOfDay(first),
      to: endOfDay(last),
    });
  }
  return presets;
}

/**
 * Arbitrary windows, alongside the preset buttons rather than replacing them.
 * Choosing here switches the range to `custom`; choosing a preset button
 * clears the dates again.
 */
export function DateRangeFilter(): ReactNode {
  const [range, setRange] = useAtom(analyticsRangeAtom);
  const [customStart, setCustomStart] = useAtom(analyticsCustomStartAtom);
  const setCustomEnd = useSetAtom(analyticsCustomEndAtom);
  const [customEnd] = useAtom(analyticsCustomEndAtom);
  const [open, setOpen] = useState(false);

  const presets = useMemo(() => buildPresets(new Date()), []);

  const apply = useCallback(
    (from: Date, to: Date): void => {
      setCustomStart(from.toISOString());
      setCustomEnd(to.toISOString());
      setRange("custom");
      setOpen(false);
    },
    [setCustomStart, setCustomEnd, setRange]
  );

  const onSelect = useCallback(
    (selected: DateRange | undefined): void => {
      if (!selected?.from) {
        return;
      }
      // One click is a single day until a second lands, so the picker is
      // usable for "one specific day" without a second click.
      apply(startOfDay(selected.from), endOfDay(selected.to ?? selected.from));
    },
    [apply]
  );

  const active = range === "custom" && customStart !== null;

  const label = useMemo((): string => {
    if (!(active && customStart && customEnd)) {
      return "Custom";
    }
    const from = new Date(customStart);
    const to = new Date(customEnd);
    const sameDay = from.toDateString() === to.toDateString();
    return sameDay
      ? DAY_LABEL.format(from)
      : `${DAY_LABEL.format(from)} - ${DAY_LABEL.format(to)}`;
  }, [active, customStart, customEnd]);

  const selected = useMemo((): DateRange | undefined => {
    if (!(active && customStart)) {
      return undefined;
    }
    return {
      from: new Date(customStart),
      to: customEnd ? new Date(customEnd) : undefined,
    };
  }, [active, customStart, customEnd]);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Custom date range"
          className={cn("gap-1.5", active && "border-primary/40")}
          size="sm"
          variant={active ? "default" : "outline"}
        >
          <CalendarDays className="size-4" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-auto gap-0 p-0">
        <div className="flex w-36 flex-col gap-0.5 border-r p-2">
          {presets.map((preset) => (
            <Button
              className="h-7 justify-start px-2 text-xs"
              key={preset.key}
              onClick={() => apply(preset.from, preset.to)}
              size="sm"
              variant="ghost"
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <Calendar
          autoFocus
          defaultMonth={selected?.from}
          mode="range"
          numberOfMonths={2}
          onSelect={onSelect}
          selected={selected}
        />
      </PopoverContent>
    </Popover>
  );
}
