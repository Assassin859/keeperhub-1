"use client";

import { ethers } from "ethers";
import { CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AddressWithExplorer } from "@/components/safe/address-with-explorer";
import { getChainDisplayName } from "@/components/safe/chain-prefixes";
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
import { getTokenInfo } from "@/lib/contracts/tokens";

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
    protocolSlug: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    maxRefillWei: string;
    refillWei: string;
    periodSeconds: number;
    lastChainBalanceWei: string | null;
  }>;
};

const TRAILING_ZEROS_REGEX = /0+$/;
const TRAILING_DOT_REGEX = /\.$/;

/**
 * Convert a wei amount back to human-readable form for the wizard's
 * `amountHuman` field. Mirrors the formatter the simulate routes use so
 * the cap shown in the editor matches the cap shown in the install summary.
 */
function weiToHuman(amountWei: string, decimals: number): string {
  try {
    const big = BigInt(amountWei);
    if (decimals === 0) {
      return big.toString();
    }
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = big / divisor;
    const fraction = big % divisor;
    if (fraction === BigInt(0)) {
      return whole.toString();
    }
    const fractionStr = fraction
      .toString()
      .padStart(decimals, "0")
      .replace(TRAILING_ZEROS_REGEX, "");
    if (fractionStr.length === 0) {
      return whole.toString();
    }
    return `${whole.toString()}.${fractionStr}`.replace(TRAILING_DOT_REGEX, "");
  } catch {
    return amountWei;
  }
}

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
  const [syncing, setSyncing] = useState<boolean>(false);
  const [editing, setEditing] = useState<boolean>(false);

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

  const syncFromChain = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role/reconcile`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        installed?: boolean;
        addedAllowances?: number;
        updatedAllowances?: number;
        staleAllowances?: number;
        reason?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Sync failed");
        return;
      }
      if (data.installed === false) {
        toast.warning(
          "No Zodiac Roles modifier is enabled on this Safe on chain."
        );
      } else {
        const added = data.addedAllowances ?? 0;
        const updated = data.updatedAllowances ?? 0;
        const stale = data.staleAllowances ?? 0;
        if (added + updated + stale === 0) {
          toast.success("Already in sync with on-chain state");
        } else {
          toast.success(
            `Synced from chain: ${added} added, ${updated} updated, ${stale} cleared`
          );
        }
      }
      await loadRole();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [safeId, loadRole]);

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
        {isAdmin && (
          <Button
            className="ml-auto h-7 gap-1 px-2 text-xs"
            disabled={syncing}
            onClick={() => {
              syncFromChain().catch(() => {
                // toast already fired
              });
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            {syncing ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Sync from chain
          </Button>
        )}
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
            {role.role ? (
              <AddressWithExplorer
                address={role.role.rolesModifierAddress}
                chainId={chainId}
              />
            ) : (
              <span className="text-muted-foreground">-</span>
            )}
            {safeUrl && (
              <a
                className="mt-2 block text-muted-foreground text-xs underline hover:text-foreground"
                href={safeUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                View Safe on safe.global
              </a>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="font-medium text-sm">Enabled protocols</div>
              {isAdmin && (
                <EditRoleDialog
                  chainId={chainId}
                  editing={editing}
                  onUpdated={loadRole}
                  role={role}
                  safeId={safeId}
                  setEditing={setEditing}
                />
              )}
            </div>
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
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-3 overflow-y-auto">
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
          defaultEnabledSlugs={[]}
          onCancel={() => setOpen(false)}
          onConfirm={handleInstall}
          simulate={simulate}
          submitting={installing}
        />
      </DialogContent>
    </Dialog>
  );
}

type EditRoleDialogProps = {
  safeId: string;
  chainId: number;
  role: RoleSummary;
  editing: boolean;
  setEditing: (value: boolean) => void;
  onUpdated: () => Promise<void>;
};

/**
 * Edit-policies dialog. Opens the same `PolicyWizard` used at install time
 * but pre-filled with the role's current scoped protocols + token caps so
 * the admin can add/remove protocols and adjust caps without losing what's
 * already on chain. Submits the FULL desired state to the update endpoint;
 * the orchestrator computes the diff and submits one Safe transaction.
 *
 * Direct rule REMOVAL is intentionally not surfaced here -- the wizard's
 * direct-rule list starts empty so adding new rules is straightforward,
 * but existing direct rules can only be removed via the per-allowance
 * Revoke button. Lifting that limitation requires persisting the
 * counterparty (a follow-up schema change).
 */
function EditRoleDialog({
  safeId,
  chainId,
  role,
  editing,
  setEditing,
  onUpdated,
}: EditRoleDialogProps): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);

  // Group current allowances by protocol slug into the wizard's pre-fill
  // shape. Direct-rule buckets are excluded -- they're surfaced through
  // the per-token allowance section, not the protocol grid.
  const defaultProtocolTokens: Record<
    string,
    Array<{
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      amountHuman: string;
      periodSeconds: number;
    }>
  > = {};
  for (const allowance of role.allowances) {
    if (allowance.protocolSlug === "direct") {
      continue;
    }
    if (!defaultProtocolTokens[allowance.protocolSlug]) {
      defaultProtocolTokens[allowance.protocolSlug] = [];
    }
    defaultProtocolTokens[allowance.protocolSlug].push({
      tokenAddress: allowance.tokenAddress,
      tokenSymbol: allowance.tokenSymbol,
      tokenDecimals: allowance.tokenDecimals,
      amountHuman: weiToHuman(allowance.maxRefillWei, allowance.tokenDecimals),
      periodSeconds: allowance.periodSeconds,
    });
  }

  const defaultEnabledSlugs = role.protocols
    .filter((p) => p.protocolSlug !== "direct" && p.status === "allowed")
    .map((p) => p.protocolSlug);

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

  const handleConfirm = async (config: PolicyConfig): Promise<void> => {
    setEditing(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/role/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        noChanges?: boolean;
        addedProtocols?: number;
        removedProtocols?: number;
        addedAllowances?: number;
        changedAllowances?: number;
        revokedAllowances?: number;
      };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Update failed");
        return;
      }
      if (data.noChanges) {
        toast.info("No changes to apply");
      } else {
        const parts: string[] = [];
        if (data.addedProtocols) {
          parts.push(
            `+${data.addedProtocols} protocol${data.addedProtocols === 1 ? "" : "s"}`
          );
        }
        if (data.removedProtocols) {
          parts.push(
            `-${data.removedProtocols} protocol${data.removedProtocols === 1 ? "" : "s"}`
          );
        }
        if (data.addedAllowances) {
          parts.push(
            `+${data.addedAllowances} bucket${data.addedAllowances === 1 ? "" : "s"}`
          );
        }
        if (data.changedAllowances) {
          parts.push(
            `${data.changedAllowances} cap change${data.changedAllowances === 1 ? "" : "s"}`
          );
        }
        if (data.revokedAllowances) {
          parts.push(
            `-${data.revokedAllowances} bucket${data.revokedAllowances === 1 ? "" : "s"}`
          );
        }
        toast.success(
          parts.length > 0
            ? `Updated on chain: ${parts.join(", ")}`
            : "Updated on chain"
        );
      }
      setOpen(false);
      await onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setEditing(false);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          Edit policies
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Zodiac Roles</DialogTitle>
          <DialogDescription>
            Add or remove protocols, change token lists, or adjust per-period
            caps. The diff is computed against the current on-chain state and
            submitted as a single Safe transaction. Existing direct rules can
            only be removed via the per-allowance Revoke button.
          </DialogDescription>
        </DialogHeader>
        <PolicyWizard
          chainId={chainId}
          confirmLabel="Confirm & update"
          defaultEnabledSlugs={defaultEnabledSlugs}
          defaultProtocolTokens={defaultProtocolTokens}
          mode="edit"
          onCancel={() => setOpen(false)}
          onConfirm={handleConfirm}
          simulate={simulate}
          submitting={editing}
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
  chainId,
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
  const [recognizedToken, setRecognizedToken] = useState<{
    symbol: string;
    decimals: number;
  } | null>(null);

  // When the user pastes a known token address for the active chain, fill in
  // its decimals automatically and surface "Recognized: USDC" so the modal
  // does not look like it's silently rewriting their input. Fields stay
  // editable for tokens not in the registry (or for forks/wrapped variants
  // where the canonical decimals would be wrong).
  useEffect(() => {
    if (!ethers.isAddress(tokenAddress)) {
      setRecognizedToken(null);
      return;
    }
    const info = getTokenInfo(chainId, tokenAddress);
    if (!info) {
      setRecognizedToken(null);
      return;
    }
    setRecognizedToken({ symbol: info.symbol, decimals: info.decimals });
    setDecimals(String(info.decimals));
  }, [tokenAddress, chainId]);

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
            {recognizedToken && (
              <div className="mt-1 flex items-center gap-1 text-emerald-500/80 text-xs">
                <CheckCircle2 className="h-3 w-3" />
                Recognized {recognizedToken.symbol} ({recognizedToken.decimals}{" "}
                decimals) on {getChainDisplayName(chainId)}
              </div>
            )}
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
