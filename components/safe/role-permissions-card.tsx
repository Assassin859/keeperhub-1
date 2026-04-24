"use client";

import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  type PolicyConfig,
  PolicyWizard,
  type SimulationPlan,
} from "@/components/safe/policy-wizard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { truncateAddress } from "@/lib/address-utils";

type RoleSummary = {
  installed: boolean;
  role: null | {
    id: string;
    safeWalletId: string;
    roleKey: string;
    rolesModifierAddress: string;
    delegateAddress: string;
    status: string;
  };
  protocols: Array<{
    id: string;
    protocolSlug: string;
    templateSlug: string;
    allowedTokenSymbols: string[];
    status: string;
  }>;
  allowances: Array<{
    id: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    maxRefillWei: string;
    refillWei: string;
    periodSeconds: number;
    lastChainBalanceWei: string | null;
  }>;
};

// Protocol catalog + SimulationPlan type now live in policy-wizard.tsx.

const PERIOD_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "Daily", seconds: 86_400 },
  { label: "Weekly", seconds: 604_800 },
  { label: "Monthly", seconds: 2_592_000 },
];

const LEADING_ZEROS_REGEX = /^0+/;

type Props = {
  safeId: string;
  chainId: number;
  isAdmin: boolean;
  safeUrl?: string | null;
};

export function RolePermissionsCard({
  safeId,
  chainId,
  isAdmin,
  safeUrl,
}: Props): React.ReactElement | null {
  const [loading, setLoading] = useState<boolean>(true);
  const [role, setRole] = useState<RoleSummary | null>(null);
  const [installing, setInstalling] = useState<boolean>(false);
  const [addingAllowance, setAddingAllowance] = useState<boolean>(false);

  const loadRole = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role`);
      if (!res.ok) {
        toast.error("Failed to load role state");
        return;
      }
      const data = (await res.json()) as RoleSummary;
      setRole(data);
    } catch {
      toast.error("Failed to load role state");
    } finally {
      setLoading(false);
    }
  }, [safeId]);

  useEffect(() => {
    loadRole().catch(() => {
      // toast already fired
    });
  }, [loadRole]);

  if (!(isAdmin || role?.installed)) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">
          On-chain policies (Zodiac Roles)
        </h3>
      </div>
      <p className="mb-4 text-muted-foreground text-xs">
        Workflow transactions on this Safe are enforced on-chain: only the
        allowed protocols + functions are executable, and every token spend is
        decremented from its per-token allowance. Owner calls via safe.global
        bypass the role.
      </p>

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Spinner />
        </div>
      )}

      {!loading && role && !role.installed && isAdmin && (
        <InstallRoleDialog
          chainId={chainId}
          installing={installing}
          onInstalled={loadRole}
          safeId={safeId}
          setInstalling={setInstalling}
        />
      )}

      {!loading && role?.installed && (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/20 p-3 text-xs">
            <div className="mb-1 font-medium">Zodiac Roles Modifier</div>
            <div className="text-muted-foreground">
              {role.role
                ? truncateAddress(role.role.rolesModifierAddress)
                : "-"}
            </div>
            {safeUrl && (
              <a
                className="mt-2 inline-block text-muted-foreground text-xs underline hover:text-foreground"
                href={safeUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                View on safe.global
              </a>
            )}
          </div>

          <div>
            <div className="mb-2 font-medium text-sm">Enabled protocols</div>
            <ul className="space-y-1">
              {role.protocols.map((p) => (
                <li
                  className="flex items-center justify-between rounded border bg-muted/20 px-3 py-2 text-sm"
                  key={p.id}
                >
                  <span>{p.protocolSlug}</span>
                  <span className="text-muted-foreground text-xs">
                    {p.allowedTokenSymbols.join(", ")}
                  </span>
                </li>
              ))}
              {role.protocols.length === 0 && (
                <li className="text-muted-foreground text-xs">
                  No protocols enabled yet.
                </li>
              )}
            </ul>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="font-medium text-sm">Per-token allowances</div>
              {isAdmin && (
                <AddAllowanceDialog
                  adding={addingAllowance}
                  chainId={chainId}
                  onAdded={loadRole}
                  safeId={safeId}
                  setAdding={setAddingAllowance}
                />
              )}
            </div>
            <ul className="space-y-1">
              {role.allowances.map((a) => (
                <AllowanceRow
                  allowance={a}
                  isAdmin={isAdmin}
                  key={a.id}
                  onRevoked={loadRole}
                  safeId={safeId}
                />
              ))}
              {role.allowances.length === 0 && (
                <li className="text-muted-foreground text-xs">
                  No spending limits configured.
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

type InstallDialogProps = {
  safeId: string;
  chainId: number;
  installing: boolean;
  setInstalling: (value: boolean) => void;
  onInstalled: () => Promise<void>;
};

function InstallRoleDialog({
  safeId,
  chainId,
  installing,
  setInstalling,
  onInstalled,
}: InstallDialogProps): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);

  const simulate = async (
    config: PolicyConfig
  ): Promise<SimulationPlan | null> => {
    const res = await fetch(`/api/user/safe/${safeId}/role/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
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

  const handleInstall = async (config: PolicyConfig): Promise<void> => {
    setInstalling(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        skipped?: string[];
        conflictedTokens?: Array<{ tokenSymbol: string }>;
      };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Install failed");
        return;
      }
      if (data.skipped && data.skipped.length > 0) {
        toast.warning(
          `Skipped protocols not available on this chain: ${data.skipped.join(", ")}`
        );
      }
      if (data.conflictedTokens && data.conflictedTokens.length > 0) {
        toast.warning(
          `Resolved conflicts on ${data.conflictedTokens.map((c) => c.tokenSymbol).join(", ")}`
        );
      }
      toast.success(`Zodiac Roles installed on chain ${chainId}`);
      setOpen(false);
      await onInstalled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Install failed");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="w-full" type="button">
          Enable on-chain policies
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install Zodiac Roles</DialogTitle>
          <DialogDescription>
            Scope workflow execution on this Safe to the selected protocols and
            per-token limits. Review shows every on-chain operation and the
            estimated gas cost before you confirm.
          </DialogDescription>
        </DialogHeader>
        <PolicyWizard
          chainId={chainId}
          confirmLabel="Confirm & install"
          defaultEnabledSlugs={["aave-v3", "cowswap"]}
          onCancel={() => setOpen(false)}
          onConfirm={handleInstall}
          simulate={simulate}
          submitting={installing}
        />
      </DialogContent>
    </Dialog>
  );
}

type AddAllowanceProps = {
  safeId: string;
  chainId: number;
  adding: boolean;
  setAdding: (v: boolean) => void;
  onAdded: () => Promise<void>;
};

function AddAllowanceDialog({
  safeId,
  adding,
  setAdding,
  onAdded,
}: AddAllowanceProps): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const [tokenAddress, setTokenAddress] = useState<string>("");
  const [amountHuman, setAmountHuman] = useState<string>("");
  const [decimals, setDecimals] = useState<string>("6");
  const [periodSeconds, setPeriodSeconds] = useState<number>(
    PERIOD_PRESETS[1].seconds
  );

  const handleAdd = async (): Promise<void> => {
    if (!(tokenAddress && amountHuman)) {
      toast.error("Token address and amount are required");
      return;
    }
    const decimalsNum = Number.parseInt(decimals, 10);
    if (!Number.isFinite(decimalsNum) || decimalsNum < 0) {
      toast.error("Decimals must be a non-negative integer");
      return;
    }
    let maxRefillWei: bigint;
    try {
      const [intPart, fracPartRaw] = amountHuman.split(".");
      const fracPart = (fracPartRaw ?? "")
        .padEnd(decimalsNum, "0")
        .slice(0, decimalsNum);
      const combined =
        `${intPart}${fracPart}`.replace(LEADING_ZEROS_REGEX, "") || "0";
      maxRefillWei = BigInt(combined);
    } catch {
      toast.error("Invalid amount");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role/allowances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenAddress,
          maxRefillWei: maxRefillWei.toString(),
          refillWei: maxRefillWei.toString(),
          periodSeconds,
          tokenDecimals: decimalsNum,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Failed to set allowance");
        return;
      }
      toast.success("Spending limit set on-chain");
      setOpen(false);
      setTokenAddress("");
      setAmountHuman("");
      await onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          + Add limit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set spending limit</DialogTitle>
          <DialogDescription>
            Caps how much of this token the role can spend per period on-chain.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Token address</Label>
            <Input
              onChange={(e) => setTokenAddress(e.target.value)}
              placeholder="0x..."
              value={tokenAddress}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Amount per period</Label>
              <Input
                onChange={(e) => setAmountHuman(e.target.value)}
                placeholder="100"
                value={amountHuman}
              />
            </div>
            <div>
              <Label className="text-xs">Decimals</Label>
              <Input
                onChange={(e) => setDecimals(e.target.value)}
                placeholder="6"
                value={decimals}
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Refill period</Label>
            <div className="mt-1 flex gap-2">
              {PERIOD_PRESETS.map((p) => (
                <Button
                  key={p.seconds}
                  onClick={() => setPeriodSeconds(p.seconds)}
                  size="sm"
                  type="button"
                  variant={periodSeconds === p.seconds ? "default" : "outline"}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={adding}
            onClick={() => setOpen(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={adding} onClick={handleAdd} type="button">
            {adding ? <Spinner className="h-4 w-4" /> : "Set on-chain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type AllowanceRowProps = {
  allowance: RoleSummary["allowances"][number];
  isAdmin: boolean;
  safeId: string;
  onRevoked: () => Promise<void>;
};

function AllowanceRow({
  allowance,
  isAdmin,
  safeId,
  onRevoked,
}: AllowanceRowProps): React.ReactElement {
  const [revoking, setRevoking] = useState<boolean>(false);

  const handleRevoke = async (): Promise<void> => {
    setRevoking(true);
    try {
      const res = await fetch(
        `/api/user/safe/${safeId}/role/allowances/${allowance.tokenAddress}`,
        { method: "DELETE" }
      );
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Revoke failed");
        return;
      }
      toast.success(`Revoked ${allowance.tokenSymbol} allowance`);
      await onRevoked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setRevoking(false);
    }
  };

  // Format balances for display
  const formatWei = (wei: string): string => {
    try {
      const big = BigInt(wei);
      const divisor = BigInt(10) ** BigInt(allowance.tokenDecimals);
      const whole = big / divisor;
      const remainder = big % divisor;
      const remainderStr = remainder
        .toString()
        .padStart(allowance.tokenDecimals, "0")
        .slice(0, 4);
      return `${whole.toString()}.${remainderStr}`;
    } catch {
      return wei;
    }
  };

  const remaining = allowance.lastChainBalanceWei ?? allowance.maxRefillWei;

  return (
    <li className="flex items-center justify-between rounded border bg-muted/20 px-3 py-2 text-sm">
      <div className="flex flex-col">
        <span className="font-medium">{allowance.tokenSymbol}</span>
        <span className="text-muted-foreground text-xs">
          {formatWei(remaining)} / {formatWei(allowance.maxRefillWei)} left ·
          refills every{" "}
          {Math.max(1, Math.floor(allowance.periodSeconds / 86_400))}d
        </span>
      </div>
      {isAdmin && (
        <Button
          disabled={revoking}
          onClick={handleRevoke}
          size="sm"
          type="button"
          variant="ghost"
        >
          {revoking ? <Spinner className="h-4 w-4" /> : "Revoke"}
        </Button>
      )}
    </li>
  );
}
