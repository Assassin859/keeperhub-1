"use client";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ENFORCEMENT_LEVEL_LABELS,
  ENFORCEMENT_LEVEL_TOOLTIPS,
  type EnforcementLevel,
  type ProtocolCatalogEntry,
} from "@/lib/safe/protocol-registry";
import {
  POLICY_PERIOD_OPTIONS,
  PolicyTokenRow,
  type TokenRowValue,
} from "./policy-token-row";
import { type PickedToken, TokenPicker } from "./token-picker";

/**
 * One protocol card inside the policy wizard:
 *   - Checkbox to enable + header row with enforcement-level badge
 *   - Expandable target-contract list with explorer links
 *   - Per-token rows with amount + period + remove
 *   - Add-token button backed by <TokenPicker>
 *
 * The card is controlled: the parent owns the enabled/tokens state and
 * updates it through the `onTokensChange` / `onEnabledChange` callbacks.
 */

const DEFAULT_PERIOD = POLICY_PERIOD_OPTIONS[1].seconds;

type TargetLink = {
  address: string;
  explorerUrl: string | null;
};

type PolicyProtocolCardProps = {
  catalog: ProtocolCatalogEntry;
  chainId: number;
  enabled: boolean;
  tokens: TokenRowValue[];
  targets: readonly TargetLink[];
  onEnabledChange: (next: boolean) => void;
  onTokensChange: (next: TokenRowValue[]) => void;
};

function truncateAddress(addr: string): string {
  if (addr.length < 12) {
    return addr;
  }
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function EnforcementBadge({
  level,
}: {
  level: EnforcementLevel;
}): React.ReactElement {
  const variant = level === "per-parameter" ? "default" : "secondary";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className="cursor-help text-[10px]" variant={variant}>
          {ENFORCEMENT_LEVEL_LABELS[level]}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        {ENFORCEMENT_LEVEL_TOOLTIPS[level]}
      </TooltipContent>
    </Tooltip>
  );
}

export function PolicyProtocolCard({
  catalog,
  chainId,
  enabled,
  tokens,
  targets,
  onEnabledChange,
  onTokensChange,
}: PolicyProtocolCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);

  const handleTokenPicked = (picked: PickedToken): void => {
    const next: TokenRowValue = {
      tokenAddress: picked.tokenAddress,
      tokenSymbol: picked.tokenSymbol,
      tokenDecimals: picked.tokenDecimals,
      amountHuman: "",
      periodSeconds: DEFAULT_PERIOD,
      explorerUrl: picked.explorerUrl ?? null,
    };
    onTokensChange([...tokens, next]);
  };

  const updateTokenAt = (index: number, next: TokenRowValue): void => {
    const copy = tokens.slice();
    copy[index] = next;
    onTokensChange(copy);
  };

  const removeTokenAt = (index: number): void => {
    const copy = tokens.slice();
    copy.splice(index, 1);
    onTokensChange(copy);
  };

  return (
    <li
      className={`rounded border p-3 text-sm ${
        enabled ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <input
          checked={enabled}
          className="mt-1"
          id={`pw-protocol-${catalog.slug}`}
          onChange={(e) => onEnabledChange(e.target.checked)}
          type="checkbox"
        />
        <label
          className="flex-1 cursor-pointer"
          htmlFor={`pw-protocol-${catalog.slug}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{catalog.label}</span>
            <EnforcementBadge level={catalog.enforcementLevel} />
            {catalog.docsUrl && (
              <a
                className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                href={catalog.docsUrl}
                onClick={(e) => e.stopPropagation()}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLinkIcon className="h-3 w-3" />
                docs
              </a>
            )}
          </div>
          <div className="text-muted-foreground text-xs">
            {catalog.description}
          </div>
        </label>
        <Button
          aria-expanded={expanded}
          aria-label={expanded ? "Hide details" : "Show details"}
          onClick={() => setExpanded((v) => !v)}
          size="icon"
          type="button"
          variant="ghost"
        >
          {expanded ? (
            <ChevronDownIcon className="h-4 w-4" />
          ) : (
            <ChevronRightIcon className="h-4 w-4" />
          )}
        </Button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 rounded bg-muted/20 p-2">
          <div className="text-muted-foreground text-xs">
            Contracts scoped for this protocol on chain {chainId}
            {targets.length === 0 && ": none registered."}
          </div>
          {targets.length > 0 && (
            <ul className="space-y-1 text-xs">
              {targets.map((t) => (
                <li
                  className="flex items-center gap-2 font-mono text-muted-foreground"
                  key={t.address}
                >
                  <span>{truncateAddress(t.address)}</span>
                  {t.explorerUrl && (
                    <a
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      href={t.explorerUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <ExternalLinkIcon className="h-3 w-3" />
                      verify
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {enabled && (
        <div className="mt-3 space-y-2">
          {tokens.length === 0 && (
            <div className="rounded bg-muted/20 p-2 text-muted-foreground text-xs">
              No tokens added yet. Click Add token to scope which tokens this
              protocol can spend.
            </div>
          )}
          {tokens.map((t, idx) => (
            <PolicyTokenRow
              key={t.tokenAddress}
              onChange={(next) => updateTokenAt(idx, next)}
              onRemove={() => removeTokenAt(idx)}
              value={t}
            />
          ))}
          <Button
            onClick={() => setPickerOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            + Add token
          </Button>
        </div>
      )}

      <TokenPicker
        chainId={chainId}
        excludeAddresses={tokens.map((t) => t.tokenAddress)}
        onOpenChange={setPickerOpen}
        onSelect={handleTokenPicked}
        open={pickerOpen}
      />
    </li>
  );
}
