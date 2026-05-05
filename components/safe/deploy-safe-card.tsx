"use client";

import { Copy, ExternalLink, Plus, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getExplorerAddressUrl,
  getSafeAppUrl,
} from "@/components/safe/chain-prefixes";
import {
  type PolicyConfig,
  PolicyWizard,
  type SimulationPlan,
} from "@/components/safe/policy-wizard";
import { RolePermissionsCard } from "@/components/safe/role-permissions-card";
import { SafeSigningToggle } from "@/components/safe/safe-signing-toggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";

type SafeSummary = {
  id: string;
  chainId: number;
  safeAddress: string;
  owners: string[];
  threshold: number;
  safeVersion: string;
  deploymentTxHash: string | null;
  deploymentBlock: number | null;
  status: string;
  isSigningActive: boolean;
  deployedAt: string | null;
};

type ListResponse = {
  safes: SafeSummary[];
  supportedChainIds: number[];
};

type DeployResponse = {
  success?: true;
  alreadyDeployed?: boolean;
  safe?: SafeSummary;
  error?: string;
};

const WIZARD_DEFAULT_PROTOCOLS: readonly string[] = [];

// Label map covers every chain we might ever render, not just the
// currently deploy-supported set, so stale or legacy rows render with a
// real name instead of the "Chain <id>" fallback.
const CHAIN_LABELS: Record<number, string> = {
  // mainnets
  1: "Ethereum",
  10: "Optimism",
  8453: "Base",
  42161: "Arbitrum One",
  56: "BNB Smart Chain",
  137: "Polygon",
  43114: "Avalanche",
  // testnets
  11155111: "Ethereum Sepolia",
  11155420: "Optimism Sepolia",
  84532: "Base Sepolia",
  421614: "Arbitrum Sepolia",
  97: "BSC Testnet",
  80002: "Polygon Amoy",
  43113: "Avalanche Fuji",
};

function chainLabel(chainId: number): string {
  return CHAIN_LABELS[chainId] ?? `Chain ${chainId}`;
}

function DeployedSafeRow({
  safe,
  isAdmin,
  onSigningChange,
}: {
  safe: SafeSummary;
  isAdmin: boolean;
  onSigningChange: (safeId: string, next: boolean) => void;
}): React.ReactElement {
  const label = chainLabel(safe.chainId);
  const checksummed = toChecksumAddress(safe.safeAddress);
  const explorerUrl = getExplorerAddressUrl(safe.chainId, safe.safeAddress);
  const safeAppUrl = getSafeAppUrl(safe.chainId, safe.safeAddress);

  const handleCopy = (): void => {
    navigator.clipboard.writeText(checksummed);
    toast.success("Safe address copied");
  };

  return (
    <li className="space-y-3 rounded-md border bg-muted/20 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{label}</span>
            {safe.isSigningActive && (
              <span className="rounded-full bg-keeperhub-green/10 px-1.5 py-0.5 font-medium text-[10px] text-keeperhub-green/80 uppercase tracking-wide">
                Active signer
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-muted-foreground text-xs">
            <code className="break-all font-mono">
              {truncateAddress(checksummed)}
            </code>
            <button
              aria-label="Copy Safe address"
              className="hover:text-foreground"
              onClick={handleCopy}
              type="button"
            >
              <Copy className="h-3 w-3" />
            </button>
            {explorerUrl && (
              <a
                aria-label="View on explorer"
                className="hover:text-foreground"
                href={explorerUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {safeAppUrl && (
              <a
                className="ml-1 text-muted-foreground text-xs hover:text-foreground"
                href={safeAppUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                View on Safe
              </a>
            )}
          </div>
          <div className="text-muted-foreground text-xs">
            {safe.threshold}/{safe.owners.length} owners - v{safe.safeVersion}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs capitalize ${
            safe.status === "deployed"
              ? "bg-keeperhub-green/10 text-keeperhub-green/80"
              : "bg-muted/50 text-muted-foreground"
          }`}
        >
          {safe.status}
        </span>
      </div>

      {safe.status === "deployed" && (
        <SafeSigningToggle
          chainLabel={label}
          isActive={safe.isSigningActive}
          isAdmin={isAdmin}
          onChange={(next) => onSigningChange(safe.id, next)}
          safeId={safe.id}
        />
      )}

      {safe.status === "deployed" && (
        <RolePermissionsCard
          chainId={safe.chainId}
          isAdmin={isAdmin}
          safeAddress={safe.safeAddress}
          safeId={safe.id}
        />
      )}
    </li>
  );
}

/**
 * Two-step deploy wizard:
 *   Step 1 -- chain + opt-in to policies
 *   Step 2 -- (only shown if opted in) shared <PolicyWizard> for the
 *             selected chain. Same UI as the post-deploy install dialog.
 *
 * Submits the Safe deploy first; if policies are enabled, the parent chains
 * the POST to /api/user/safe/[safeId]/role with the collected config.
 */
function DeployDialog({
  open,
  onOpenChange,
  deployableChainIds,
  onDeploy,
  deploying,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deployableChainIds: number[];
  onDeploy: (
    chainId: number,
    policyConfig: PolicyConfig | null
  ) => Promise<void>;
  deploying: boolean;
}): React.ReactElement {
  const [step, setStep] = useState<"chain" | "policies">("chain");
  const [selectedChain, setSelectedChain] = useState<string>("");
  const [enablePolicies, setEnablePolicies] = useState<boolean>(true);

  const resetWizard = (): void => {
    setStep("chain");
    setSelectedChain("");
    setEnablePolicies(true);
  };

  const handleNext = async (): Promise<void> => {
    const chainId = Number.parseInt(selectedChain, 10);
    if (!Number.isFinite(chainId)) {
      toast.error("Select a chain");
      return;
    }
    if (!enablePolicies) {
      await onDeploy(chainId, null);
      resetWizard();
      return;
    }
    setStep("policies");
  };

  const handleBack = (): void => {
    setStep("chain");
  };

  const handleConfirmWithPolicies = async (
    config: PolicyConfig
  ): Promise<void> => {
    const chainId = Number.parseInt(selectedChain, 10);
    if (!Number.isFinite(chainId)) {
      toast.error("Select a chain");
      return;
    }
    await onDeploy(chainId, config);
    resetWizard();
  };

  const handleSimulateDeploy = async (
    config: PolicyConfig
  ): Promise<SimulationPlan | null> => {
    const chainId = Number.parseInt(selectedChain, 10);
    if (!Number.isFinite(chainId)) {
      throw new Error("Select a chain before simulating");
    }
    const res = await fetch("/api/user/safe/simulate-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId, protocols: config.protocols }),
    });
    const data = (await res.json()) as SimulationPlan | { error?: string };
    if (!res.ok || "error" in data) {
      const message =
        "error" in data
          ? (data.error ?? "Simulation failed")
          : "Simulation failed";
      throw new Error(message);
    }
    return data as SimulationPlan;
  };

  const chainIdNumber = Number.parseInt(selectedChain, 10);
  const hasValidChain = Number.isFinite(chainIdNumber);

  return (
    <Dialog
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          resetWizard();
        }
      }}
      open={open}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === "chain"
              ? "Deploy Safe on a new chain"
              : "Configure on-chain policies"}
          </DialogTitle>
          <DialogDescription>
            {step === "chain"
              ? "The organization EOA becomes the sole owner at threshold 1. Gas is paid from the EOA's balance on the target chain."
              : "Pick the protocols and per-token limits that should be enforced on this Safe. The same policies can be edited later from the Safe card."}
          </DialogDescription>
        </DialogHeader>

        {step === "chain" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs" htmlFor="safe-deploy-dialog-chain">
                Chain
              </Label>
              <Select
                disabled={deploying}
                onValueChange={setSelectedChain}
                value={selectedChain}
              >
                <SelectTrigger id="safe-deploy-dialog-chain">
                  <SelectValue placeholder="Select a chain" />
                </SelectTrigger>
                <SelectContent>
                  {deployableChainIds.map((id) => (
                    <SelectItem key={id} value={id.toString()}>
                      {chainLabel(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label
              className="flex items-start gap-2 rounded-md border bg-muted/20 p-3 text-sm"
              htmlFor="safe-deploy-policies-toggle"
            >
              <input
                checked={enablePolicies}
                disabled={deploying}
                id="safe-deploy-policies-toggle"
                onChange={(e) => setEnablePolicies(e.target.checked)}
                type="checkbox"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">
                  Install on-chain policies (Zodiac Roles)
                </span>
                <span className="text-muted-foreground text-xs">
                  Scope workflow execution to a pre-audited protocol allowlist
                  with per-token spending limits. You can skip now and enable
                  later from the Safe's card.
                </span>
              </span>
            </label>
          </div>
        )}

        {step === "policies" && hasValidChain && (
          <PolicyWizard
            chainId={chainIdNumber}
            confirmLabel={
              deploying ? "Deploying..." : "Deploy + install policies"
            }
            defaultEnabledSlugs={WIZARD_DEFAULT_PROTOCOLS}
            onCancel={handleBack}
            onConfirm={handleConfirmWithPolicies}
            simulate={handleSimulateDeploy}
            submitting={deploying}
          />
        )}

        {step === "chain" && (
          <DialogFooter>
            <Button
              disabled={deploying}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={deploying || !selectedChain}
              onClick={handleNext}
              type="button"
            >
              {deploying && <Spinner className="h-4 w-4" />}
              {!deploying && (enablePolicies ? "Next" : "Deploy Safe")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DeploySafeCard({
  isAdmin,
}: {
  isAdmin: boolean;
}): React.ReactElement | null {
  const [loading, setLoading] = useState<boolean>(true);
  const [safes, setSafes] = useState<SafeSummary[]>([]);
  const [supportedChainIds, setSupportedChainIds] = useState<number[]>([]);
  const [deployOpen, setDeployOpen] = useState<boolean>(false);
  const [deploying, setDeploying] = useState<boolean>(false);

  const loadSafes = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch("/api/user/safe");
      if (!res.ok) {
        toast.error("Failed to load Safe wallets");
        return;
      }
      const data = (await res.json()) as ListResponse;
      setSafes(data.safes);
      setSupportedChainIds(data.supportedChainIds);
    } catch {
      toast.error("Failed to load Safe wallets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSafes().catch(() => {
      // Toast already fired inside loadSafes.
    });
  }, [loadSafes]);

  const deployedChainIds = new Set(safes.map((s) => s.chainId));
  const deployableChainIds = supportedChainIds.filter(
    (id) => !deployedChainIds.has(id)
  );

  const handleDeploy = async (
    chainId: number,
    policyConfig: PolicyConfig | null
  ): Promise<void> => {
    setDeploying(true);
    try {
      const res = await fetch("/api/user/safe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId }),
      });
      const data = (await res.json()) as DeployResponse;
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Safe deployment failed");
        return;
      }
      if (data.alreadyDeployed) {
        toast.info(`Safe already exists on ${chainLabel(chainId)}`);
      } else {
        toast.success(`Safe deployed on ${chainLabel(chainId)}`);
      }

      // Optionally install Zodiac Roles + initial protocol allowlist + token
      // allowances in the same flow. Deploy succeeds even if policy install
      // fails -- the admin can retry from the Safe's card.
      if (policyConfig && data.safe?.id) {
        try {
          const installRes = await fetch(
            `/api/user/safe/${data.safe.id}/role`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(policyConfig),
            }
          );
          const installData = (await installRes.json()) as {
            success?: boolean;
            error?: string;
            skipped?: string[];
          };
          if (installRes.ok && installData.success) {
            if (installData.skipped && installData.skipped.length > 0) {
              toast.warning(
                `Skipped protocols: ${installData.skipped.join(", ")}`
              );
            }
            toast.success("On-chain policies installed");
          } else {
            toast.error(
              installData.error ??
                "Policies install failed; retry from the Safe card"
            );
          }
        } catch (err) {
          toast.error(
            err instanceof Error
              ? err.message
              : "Policies install failed; retry from the Safe card"
          );
        }
      }

      setDeployOpen(false);
      await loadSafes();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Safe deployment failed"
      );
    } finally {
      setDeploying(false);
    }
  };

  const handleSigningChange = (safeId: string, next: boolean): void => {
    setSafes((current) =>
      current.map((s) =>
        s.id === safeId ? { ...s, isSigningActive: next } : s
      )
    );
  };

  if (!isAdmin && safes.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">Safe smart account</h3>
      </div>
      <p className="mb-3 text-muted-foreground text-xs">
        Deploy a Safe smart wallet on-chain per network. Safes can hold funds
        and sign workflow transactions independently from the Turnkey EOA.
      </p>

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Spinner />
        </div>
      )}

      {!loading && safes.length > 0 && (
        <ul className="mb-3 space-y-3">
          {safes.map((safe) => (
            <DeployedSafeRow
              isAdmin={isAdmin}
              key={safe.id}
              onSigningChange={handleSigningChange}
              safe={safe}
            />
          ))}
        </ul>
      )}

      {!loading && isAdmin && deployableChainIds.length > 0 && (
        <Button
          onClick={() => setDeployOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="h-3 w-3" />
          Deploy on new chain
        </Button>
      )}

      {!loading &&
        isAdmin &&
        deployableChainIds.length === 0 &&
        safes.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Safes deployed on every supported chain.
          </p>
        )}

      <DeployDialog
        deployableChainIds={deployableChainIds}
        deploying={deploying}
        onDeploy={handleDeploy}
        onOpenChange={setDeployOpen}
        open={deployOpen}
      />
    </section>
  );
}
