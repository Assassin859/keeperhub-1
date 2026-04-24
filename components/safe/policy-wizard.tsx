"use client";

import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { buildAddressUrl } from "@/lib/build-explorer-url";
import {
  type EnforcementLevel,
  listProtocolsForChain,
  type ProtocolCatalogEntry,
  type ProtocolSlug,
} from "@/lib/safe/protocol-registry";
import { getProtocolTargets } from "@/lib/safe/protocol-targets";
import { PolicyProtocolCard } from "./policy-protocol-card";
import type { TokenRowValue } from "./policy-token-row";

/**
 * Shared policy wizard used by both:
 *   1. Deploy-with-policies wizard (inside DeployDialog)
 *   2. Install-policies dialog (inside RolePermissionsCard)
 *
 * Steps: "configure" -> "review" (optional simulation result).
 *
 * The wizard emits the new per-protocol `PolicyConfig` shape consumed by
 * `installRolesWithInitialConfig` and the `/role/simulate` route:
 *   { protocols: [{ slug, tokens: [{ tokenAddress, tokenSymbol,
 *     tokenDecimals, amountHuman, periodSeconds }] }] }
 *
 * The caller owns the surrounding Dialog and controls open/close.
 */

export type TokenLimitInput = {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountHuman: string;
  periodSeconds: number;
};

export type ProtocolInput = {
  slug: string;
  tokens: TokenLimitInput[];
};

export type PolicyConfig = {
  protocols: ProtocolInput[];
};

export type SimulationPlan = {
  safe: { chainName: string; safeAddress: string };
  plan: {
    operations: Array<{ label: string; detail: string; gasUnits: string }>;
    totalGasUnits: string;
    totalCostNative: string;
    totalCostUsd: number | null;
    nativePriceUsd: number | null;
    note: string;
  };
  applied?: string[];
  skipped?: string[];
  conflictedTokens?: Array<{
    tokenAddress: string;
    tokenSymbol: string;
    resolvedAmountWei: string;
    resolvedPeriodSeconds: number;
    sourceProtocols: string[];
  }>;
};

type ExplorerInfo = {
  explorerUrl: string | null;
  explorerAddressPath: string | null;
};

export type PolicyWizardProps = {
  chainId: number;
  defaultEnabledSlugs?: readonly string[];
  submitting: boolean;
  /**
   * Optional simulator. When provided, the wizard inserts a "Review" step
   * before confirm. Return null to skip the review step entirely.
   */
  simulate?: (config: PolicyConfig) => Promise<SimulationPlan | null>;
  onConfirm: (config: PolicyConfig) => Promise<void>;
  onCancel: () => void;
  /** Label on the primary button in the final step. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Optional explorer info so target-contract links work. */
  explorer?: ExplorerInfo;
  /** Optional override for the protocol catalog (testing hook). */
  catalog?: readonly ProtocolCatalogEntry[];
};

const HUMAN_AMOUNT_REGEX = /^\d+(\.\d+)?$/;

type ProtocolState = {
  enabled: boolean;
  tokens: TokenRowValue[];
};

function ignoresTokenList(catalog: ProtocolCatalogEntry): boolean {
  return (
    catalog.templateSlug === "lido" ||
    catalog.templateSlug === "rocket-pool" ||
    catalog.templateSlug === "wrapped" ||
    catalog.templateSlug === "target-only"
  );
}

function enforcementLabel(level: EnforcementLevel): string {
  return level === "full" ? "Full policy" : "Target-only";
}

export function PolicyWizard({
  chainId,
  defaultEnabledSlugs = ["aave-v3", "cowswap"],
  submitting,
  simulate,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  explorer,
  catalog,
}: PolicyWizardProps): React.ReactElement {
  const resolvedCatalog: ProtocolCatalogEntry[] = useMemo(() => {
    if (catalog) {
      return catalog.slice();
    }
    return listProtocolsForChain(chainId);
  }, [catalog, chainId]);

  const [step, setStep] = useState<"configure" | "review">("configure");
  const [states, setStates] = useState<Record<string, ProtocolState>>(() => {
    const init: Record<string, ProtocolState> = {};
    for (const entry of resolvedCatalog) {
      init[entry.slug] = {
        enabled: defaultEnabledSlugs.includes(entry.slug),
        tokens: [],
      };
    }
    return init;
  });
  const [simulating, setSimulating] = useState<boolean>(false);
  const [simulation, setSimulation] = useState<SimulationPlan | null>(null);

  // Re-sync when chain changes (catalog may shrink/grow)
  useEffect(() => {
    setStates((prev) => {
      const next: Record<string, ProtocolState> = {};
      for (const entry of resolvedCatalog) {
        next[entry.slug] = prev[entry.slug] ?? {
          enabled: defaultEnabledSlugs.includes(entry.slug),
          tokens: [],
        };
      }
      return next;
    });
  }, [resolvedCatalog, defaultEnabledSlugs]);

  const targetsFor = useCallback(
    (slug: string): Array<{ address: string; explorerUrl: string | null }> => {
      const addrs = getProtocolTargets(slug as ProtocolSlug, chainId);
      return addrs.map((a) => ({
        address: a,
        explorerUrl: buildAddressUrl(
          explorer?.explorerUrl ?? null,
          explorer?.explorerAddressPath ?? null,
          a
        ),
      }));
    },
    [chainId, explorer]
  );

  const setEnabled = (slug: string, enabled: boolean): void => {
    setStates((prev) => ({
      ...prev,
      [slug]: {
        enabled,
        tokens: prev[slug]?.tokens ?? [],
      },
    }));
  };

  const setTokens = (slug: string, tokens: TokenRowValue[]): void => {
    setStates((prev) => ({
      ...prev,
      [slug]: {
        enabled: prev[slug]?.enabled ?? false,
        tokens,
      },
    }));
  };

  const buildConfig = (): PolicyConfig | null => {
    const protocols: ProtocolInput[] = [];
    for (const entry of resolvedCatalog) {
      const state = states[entry.slug];
      if (!state?.enabled) {
        continue;
      }
      const needsTokens = !ignoresTokenList(entry);
      if (needsTokens && state.tokens.length === 0) {
        toast.error(`Add at least one token for ${entry.label}`);
        return null;
      }
      for (const t of state.tokens) {
        if (!t.amountHuman.trim()) {
          toast.error(`Set an amount for ${t.tokenSymbol} on ${entry.label}`);
          return null;
        }
        if (!HUMAN_AMOUNT_REGEX.test(t.amountHuman.trim())) {
          toast.error(
            `Amount for ${t.tokenSymbol} on ${entry.label} must be a positive number`
          );
          return null;
        }
      }
      protocols.push({
        slug: entry.slug,
        tokens: state.tokens.map((t) => ({
          tokenAddress: t.tokenAddress,
          tokenSymbol: t.tokenSymbol,
          tokenDecimals: t.tokenDecimals,
          amountHuman: t.amountHuman.trim(),
          periodSeconds: t.periodSeconds,
        })),
      });
    }
    if (protocols.length === 0) {
      toast.error("Enable at least one protocol");
      return null;
    }
    return { protocols };
  };

  const handleNext = async (): Promise<void> => {
    const config = buildConfig();
    if (!config) {
      return;
    }
    if (!simulate) {
      await onConfirm(config);
      return;
    }
    setSimulating(true);
    try {
      const plan = await simulate(config);
      if (plan) {
        setSimulation(plan);
        setStep("review");
      } else {
        await onConfirm(config);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not simulate the plan"
      );
    } finally {
      setSimulating(false);
    }
  };

  const handleBack = (): void => {
    setStep("configure");
  };

  const handleConfirm = async (): Promise<void> => {
    const config = buildConfig();
    if (!config) {
      return;
    }
    await onConfirm(config);
  };

  return (
    <div className="flex flex-col gap-3">
      {step === "configure" && (
        <>
          <div className="rounded-md border border-amber-300/40 bg-amber-500/10 p-3 text-xs">
            <div className="mb-1 font-medium">How this works</div>
            <ul className="list-inside list-disc space-y-1 text-muted-foreground">
              <li>
                A Zodiac Roles Modifier is installed on your Safe. Workflows can
                only call the protocols and functions you enable below.
              </li>
              <li>
                For each protocol, pick the tokens it may spend, the amount per
                period, and the rotation (daily, weekly, monthly). Each cap is
                enforced on-chain per call.
              </li>
              <li>
                Protocols marked {enforcementLabel("full")} have full
                per-parameter conditions from our audited preset. Protocols
                marked {enforcementLabel("target-only")} are allowlisted at the
                contract level only.
              </li>
              <li>
                If you add the same token under two protocols with different
                limits, we take the higher amount and the shorter period and
                show a warning on the review step.
              </li>
              <li>
                Anything outside the policy reverts on-chain. You can tweak or
                revoke anytime from the Safe card.
              </li>
            </ul>
          </div>

          <div>
            <Label className="text-xs">Protocols available on this chain</Label>
            <ul className="mt-1 max-h-[28rem] space-y-2 overflow-y-auto rounded-md border p-2">
              {resolvedCatalog.map((entry) => {
                const state = states[entry.slug] ?? {
                  enabled: false,
                  tokens: [],
                };
                return (
                  <PolicyProtocolCard
                    catalog={entry}
                    chainId={chainId}
                    enabled={state.enabled}
                    ignoresTokenList={ignoresTokenList(entry)}
                    key={entry.slug}
                    onEnabledChange={(enabled) =>
                      setEnabled(entry.slug, enabled)
                    }
                    onTokensChange={(tokens) => setTokens(entry.slug, tokens)}
                    targets={targetsFor(entry.slug)}
                    tokens={state.tokens}
                  />
                );
              })}
              {resolvedCatalog.length === 0 && (
                <li className="rounded border bg-muted/20 p-3 text-muted-foreground text-xs">
                  No protocols are currently available on chain {chainId}.
                </li>
              )}
            </ul>
          </div>
        </>
      )}

      {step === "review" && simulation && (
        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-1 font-medium">Target</div>
            <div className="text-muted-foreground text-xs">
              {simulation.safe.chainName} - {simulation.safe.safeAddress}
            </div>
          </div>

          {simulation.applied && simulation.applied.length > 0 && (
            <div className="rounded-md border bg-muted/20 p-3">
              <div className="mb-1 font-medium">Protocols applied</div>
              <div className="text-muted-foreground text-xs">
                {simulation.applied.join(", ")}
              </div>
            </div>
          )}

          {simulation.skipped && simulation.skipped.length > 0 && (
            <div className="rounded-md border border-amber-300/40 bg-amber-500/10 p-3">
              <div className="mb-1 flex items-center gap-1 font-medium">
                <AlertTriangleIcon className="h-3.5 w-3.5" />
                Protocols skipped
              </div>
              <div className="text-muted-foreground text-xs">
                {simulation.skipped.join(", ")}. These are not supported on this
                chain or lack a template.
              </div>
            </div>
          )}

          {simulation.conflictedTokens &&
            simulation.conflictedTokens.length > 0 && (
              <div className="rounded-md border border-amber-300/40 bg-amber-500/10 p-3">
                <div className="mb-1 flex items-center gap-1 font-medium">
                  <AlertTriangleIcon className="h-3.5 w-3.5" />
                  Token conflicts resolved
                </div>
                <ul className="space-y-1 text-muted-foreground text-xs">
                  {simulation.conflictedTokens.map((c) => (
                    <li key={c.tokenAddress}>
                      <span className="font-medium">{c.tokenSymbol}</span>{" "}
                      appears under {c.sourceProtocols.join(", ")}. Using max
                      amount {c.resolvedAmountWei} wei and shortest period of{" "}
                      {c.resolvedPeriodSeconds}s.
                    </li>
                  ))}
                </ul>
              </div>
            )}

          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-2 font-medium">On-chain operations</div>
            <ol className="space-y-2 text-xs">
              {simulation.plan.operations.map((op) => (
                <li className="rounded border bg-background p-2" key={op.label}>
                  <div className="font-medium">{op.label}</div>
                  <div className="text-muted-foreground">{op.detail}</div>
                  <div className="mt-1 text-muted-foreground">
                    ~{op.gasUnits} gas
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-1 font-medium">Estimated total cost</div>
            <div className="font-mono text-xs">
              {simulation.plan.totalGasUnits} gas -{" "}
              {simulation.plan.totalCostNative} native
              {simulation.plan.totalCostUsd !== null && (
                <span> (~${simulation.plan.totalCostUsd.toFixed(2)})</span>
              )}
            </div>
            <p className="mt-2 text-muted-foreground text-xs">
              {simulation.plan.note}
            </p>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button
          disabled={submitting || simulating}
          onClick={step === "review" ? handleBack : onCancel}
          type="button"
          variant="outline"
        >
          {step === "review" ? "Back" : "Cancel"}
        </Button>
        {step === "configure" && (
          <Button
            disabled={submitting || simulating}
            onClick={handleNext}
            type="button"
          >
            {simulating && <Spinner className="h-4 w-4" />}
            {!simulating && (simulate ? "Review" : confirmLabel)}
          </Button>
        )}
        {step === "review" && (
          <Button disabled={submitting} onClick={handleConfirm} type="button">
            {submitting ? <Spinner className="h-4 w-4" /> : confirmLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
