"use client";

import { ExternalLinkIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * One row inside a protocol card: symbol badge + truncated address with
 * explorer link + amount input + period selector + remove button.
 *
 * Owns no state; the parent is responsible for updating the token list.
 */

export type TokenRowValue = {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountHuman: string;
  periodSeconds: number;
  explorerUrl?: string | null;
};

const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 2_592_000;

export const POLICY_PERIOD_OPTIONS: ReadonlyArray<{
  label: string;
  seconds: number;
}> = [
  { label: "Daily", seconds: DAY },
  { label: "Weekly", seconds: WEEK },
  { label: "Monthly", seconds: MONTH },
] as const;

function truncateAddress(addr: string): string {
  if (addr.length < 12) {
    return addr;
  }
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

type PolicyTokenRowProps = {
  value: TokenRowValue;
  onChange: (next: TokenRowValue) => void;
  onRemove: () => void;
};

export function PolicyTokenRow({
  value,
  onChange,
  onRemove,
}: PolicyTokenRowProps): React.ReactElement {
  const periodValue = String(value.periodSeconds);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border bg-background p-2 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-medium text-xs">
          {value.tokenSymbol}
        </span>
        <div className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
          <span className="truncate font-mono">
            {truncateAddress(value.tokenAddress)}
          </span>
          {value.explorerUrl && (
            <a
              className="inline-flex items-center gap-1 hover:text-foreground"
              href={value.explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      <Input
        className="w-28"
        inputMode="decimal"
        onChange={(e) => onChange({ ...value, amountHuman: e.target.value })}
        placeholder="100"
        value={value.amountHuman}
      />

      <Select
        onValueChange={(next) =>
          onChange({ ...value, periodSeconds: Number(next) })
        }
        value={periodValue}
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {POLICY_PERIOD_OPTIONS.map((o) => (
            <SelectItem key={o.seconds} value={String(o.seconds)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        aria-label="Remove token"
        onClick={onRemove}
        size="icon"
        type="button"
        variant="ghost"
      >
        <XIcon className="h-4 w-4" />
      </Button>
    </div>
  );
}
