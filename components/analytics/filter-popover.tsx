"use client";

import { Check, ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type FilterPopoverProps = {
  label: string;
  /** Number of values held in this dimension; 0 renders no badge. */
  selectedCount: number;
  onClear: () => void;
  children: ReactNode;
};

/** A filter dimension: a trigger showing how many values it holds, and a panel. */
export function FilterPopover({
  label,
  selectedCount,
  onClear,
  children,
}: FilterPopoverProps): ReactNode {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            "h-8 gap-1.5 px-2.5 text-xs",
            selectedCount > 0 && "border-primary/40"
          )}
          size="sm"
          variant="outline"
        >
          {label}
          {selectedCount > 0 && (
            <Badge className="h-4 px-1 text-[10px]" variant="secondary">
              {selectedCount}
            </Badge>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="max-h-80 overflow-y-auto p-1.5">{children}</div>
        <div className="flex items-center justify-between border-t px-2 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            {selectedCount > 0 ? `${selectedCount} selected` : "Showing all"}
          </span>
          <Button
            className="h-6 px-2 text-xs"
            disabled={selectedCount === 0}
            onClick={onClear}
            size="sm"
            variant="ghost"
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type ValuePopoverProps = {
  label: string;
  /** The current choice, shown on the trigger so the bar reads at a glance. */
  value: string;
  /** Receives a closer, because picking a single choice should dismiss it. */
  children: (close: () => void) => ReactNode;
};

/**
 * Single-choice dimension: the trigger carries the current value rather than a
 * count, and picking an option closes the panel, since there is nothing more to
 * choose.
 */
export function ValuePopover({
  label,
  value,
  children,
}: ValuePopoverProps): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={label}
          className="h-8 gap-1.5 px-2.5 text-xs"
          size="sm"
          variant="outline"
        >
          <span className="text-muted-foreground">{label}:</span>
          {value}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1.5">
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

type FilterCheckboxProps = {
  label: string;
  count?: number;
  checked: boolean;
  /** Some but not all of a group's members are selected. */
  indeterminate?: boolean;
  indented?: boolean;
  onToggle: () => void;
};

export function FilterCheckbox({
  label,
  count,
  checked,
  indeterminate = false,
  indented = false,
  onToggle,
}: FilterCheckboxProps): ReactNode {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
        indented && "pl-7"
      )}
      onClick={onToggle}
      type="button"
    >
      <Checkbox
        checked={indeterminate ? "indeterminate" : checked}
        className="pointer-events-none"
        tabIndex={-1}
      />
      <span className={cn("flex-1", !indented && "font-medium")}>{label}</span>
      {count !== undefined && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

type FilterRadioProps = {
  label: string;
  checked: boolean;
  onSelect: () => void;
};

export function FilterRadio({
  label,
  checked,
  onSelect,
}: FilterRadioProps): ReactNode {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
      onClick={onSelect}
      type="button"
    >
      <Check
        className={cn("size-3.5", checked ? "opacity-100" : "opacity-0")}
      />
      <span className="flex-1">{label}</span>
    </button>
  );
}

type FilterChipProps = {
  label: string;
  onRemove: () => void;
};

/** One applied filter, shown under the bar so the narrowing stays visible. */
export function FilterChip({ label, onRemove }: FilterChipProps): ReactNode {
  return (
    <Badge className="gap-1 pr-1 font-normal" variant="secondary">
      {label}
      <button
        aria-label={`Remove ${label} filter`}
        className="rounded-sm p-0.5 hover:bg-background/60"
        onClick={onRemove}
        type="button"
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}
