"use client";

import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SpendingLimitsCard } from "@/components/safe/spending-limits-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { truncateAddress } from "@/lib/address-utils";

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

const CHAIN_LABELS: Record<number, string> = {
  // mainnets
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum One",
  56: "BNB Smart Chain",
  137: "Polygon",
  43114: "Avalanche",
  // testnets
  11155111: "Ethereum Sepolia",
  84532: "Base Sepolia",
  421614: "Arbitrum Sepolia",
  97: "BSC Testnet",
  80002: "Polygon Amoy",
  43113: "Avalanche Fuji",
};

function chainLabel(chainId: number): string {
  return CHAIN_LABELS[chainId] ?? `Chain ${chainId}`;
}

export function DeploySafeCard({
  isAdmin,
}: {
  isAdmin: boolean;
}): React.ReactElement | null {
  const [loading, setLoading] = useState<boolean>(true);
  const [safes, setSafes] = useState<SafeSummary[]>([]);
  const [supportedChainIds, setSupportedChainIds] = useState<number[]>([]);
  const [selectedChainId, setSelectedChainId] = useState<string>("");
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

  const handleDeploy = async (): Promise<void> => {
    const chainId = Number.parseInt(selectedChainId, 10);
    if (!Number.isFinite(chainId)) {
      toast.error("Select a chain to deploy on");
      return;
    }
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
      setSelectedChainId("");
      await loadSafes();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Safe deployment failed"
      );
    } finally {
      setDeploying(false);
    }
  };

  if (!isAdmin && safes.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">Safe smart account</h3>
      </div>
      <p className="mb-4 text-muted-foreground text-xs">
        Deploy a Safe smart wallet on-chain. The organization EOA is the sole
        owner at deploy time; owners and threshold can be changed later.
      </p>

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Spinner />
        </div>
      )}

      {!loading && safes.length > 0 && (
        <ul className="mb-4 space-y-3">
          {safes.map((safe) => (
            <li
              className="rounded-md border bg-muted/30 px-3 py-2 text-sm"
              key={safe.id}
            >
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="font-medium">
                    {chainLabel(safe.chainId)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {truncateAddress(safe.safeAddress)} - {safe.threshold}/
                    {safe.owners.length} - v{safe.safeVersion}
                  </span>
                </div>
                <span className="text-muted-foreground text-xs capitalize">
                  {safe.status}
                </span>
              </div>
              {safe.status === "deployed" && (
                <SpendingLimitsCard
                  chainId={safe.chainId}
                  isAdmin={isAdmin}
                  safeId={safe.id}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {!loading && isAdmin && deployableChainIds.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs" htmlFor="safe-deploy-chain">
            Deploy on chain
          </Label>
          <div className="flex gap-2">
            <Select
              disabled={deploying}
              onValueChange={setSelectedChainId}
              value={selectedChainId}
            >
              <SelectTrigger className="flex-1" id="safe-deploy-chain">
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
            <Button
              disabled={deploying || !selectedChainId}
              onClick={handleDeploy}
              type="button"
            >
              {deploying ? <Spinner className="h-4 w-4" /> : "Deploy"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Gas is paid from the organization EOA.
          </p>
        </div>
      )}

      {!loading &&
        isAdmin &&
        deployableChainIds.length === 0 &&
        safes.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Safe wallets are deployed on every supported chain.
          </p>
        )}
    </div>
  );
}
