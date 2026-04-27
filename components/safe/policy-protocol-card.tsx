"use client";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import type { TokenRowValue } from "./policy-token-row";
import { ProtocolTokenAllowances } from "./protocol-token-allowances";

/**
 * One protocol card inside the policy wizard:
 *   - Checkbox to enable + header row with enforcement-level badge tooltip
 *   - Chevron that collapses the entire body (target contracts + token rows).
 *     Collapsing the chevron NEVER mutates the configured tokens; the parent
 *     keeps them in state so re-expanding shows the same caps.
 *   - <ProtocolTokenAllowances> renders the per-token rows + Add button when
 *     the protocol is enabled, regardless of expansion: collapsing only
 *     hides the UI.
 *
 * The card is fully controlled: the parent owns the enabled/tokens state and
 * updates it through the `onTokensChange` / `onEnabledChange` callbacks.
 */

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
  // Cards expand by default when the protocol starts enabled so the admin
  // can see the seeded token caps. Collapsing/expanding never touches the
  // parent's token state; tokens persist through any number of toggles.
  const [expanded, setExpanded] = useState<boolean>(enabled);

  // Newly-enabling a previously-disabled protocol auto-expands it so the
  // admin sees the rows they're about to configure. Disabling does NOT
  // auto-collapse: the admin may want to keep the rows visible while
  // deciding whether to keep them.
  useEffect(() => {
    if (enabled) {
      setExpanded(true);
    }
  }, [enabled]);

  const handleEnabledChange = (next: boolean): void => {
    onEnabledChange(next);
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
          onChange={(e) => handleEnabledChange(e.target.checked)}
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

      {expanded && enabled && (
        <div className="mt-3">
          <ProtocolTokenAllowances
            chainId={chainId}
            onChange={onTokensChange}
            tokens={tokens}
          />
        </div>
      )}

      {expanded && targets.length > 0 && (
        <div className="mt-3 space-y-2 rounded bg-muted/20 p-2">
          <div className="text-muted-foreground text-xs">
            Contracts scoped for this protocol on chain {chainId}
          </div>
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
        </div>
      )}
    </li>
  );
}
