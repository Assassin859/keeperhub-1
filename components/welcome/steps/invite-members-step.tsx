"use client";

import { Plus, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { isAddress } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InvitePreview } from "@/components/welcome/previews";
import { WelcomeShell } from "@/components/welcome/welcome-shell";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { authClient, useSession } from "@/lib/auth-client";
import { isDisposableEmailDomain } from "@/lib/auth-disposable-emails";
import { useOrganization } from "@/lib/hooks/use-organization";
import { cn } from "@/lib/utils";

const NEXT_PATH = "/welcome/connect-agent";
const BACK_PATH = "/welcome/create-org";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type InviteRole = "member" | "admin";
type InviteRow = { id: string; value: string; role: InviteRole };

function newRow(): InviteRow {
  return { id: nanoid(), value: "", role: "member" };
}

/**
 * A row is valid when it is either a valid (checksum-strict) wallet address, or
 * a well-formed email that is not disposable/blacklisted or a synthetic wallet
 * address, matching the signup email rules.
 */
function isValidInvite(value: string): boolean {
  const v = value.trim();
  if (!v) {
    return false;
  }
  if (v.startsWith("0x")) {
    return isAddress(v);
  }
  return EMAIL_RE.test(v) && !(isWalletEmail(v) || isDisposableEmailDomain(v));
}

/** Ids of rows whose (case-insensitive) value collides with another row. */
function duplicateRowIds(rows: InviteRow[]): Set<string> {
  const byKey = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.value.trim().toLowerCase();
    if (!key) {
      continue;
    }
    byKey.set(key, [...(byKey.get(key) ?? []), row.id]);
  }
  const dups = new Set<string>();
  for (const ids of byKey.values()) {
    if (ids.length > 1) {
      for (const id of ids) {
        dups.add(id);
      }
    }
  }
  return dups;
}

/** Wizard step 2: invite teammates by email or wallet address. */
export function InviteMembersStep(): React.ReactElement {
  const router = useRouter();
  const { organization } = useOrganization();
  const { data: session } = useSession();
  const [rows, setRows] = useState<InviteRow[]>([newRow()]);
  const [sending, setSending] = useState(false);

  const user = session?.user;
  const ownerLabel =
    user?.email && !isWalletEmail(user.email)
      ? user.email
      : (user?.name ?? "You");

  // The signed-in user is already in the org and can't be re-invited. Works for
  // every account kind: match their email (email/social) or, for wallet
  // accounts, the address in their synthetic email.
  const selfEmail = user?.email?.trim().toLowerCase();
  const selfAddress =
    selfEmail && isWalletEmail(selfEmail)
      ? (selfEmail.split("@")[0] ?? "")
      : "";
  const isSelf = (value: string): boolean => {
    const v = value.trim().toLowerCase();
    return (
      v.length > 0 &&
      (v === selfEmail || (selfAddress !== "" && v === selfAddress))
    );
  };

  const dupIds = duplicateRowIds(rows);
  // Per-row reason, shown inline and used to gate Next. Empty rows are neutral.
  const rowError = (row: InviteRow): string | null => {
    const v = row.value.trim();
    if (!v) {
      return null;
    }
    if (isSelf(v)) {
      return "You're already in this organization.";
    }
    if (dupIds.has(row.id)) {
      return "This invite is duplicated.";
    }
    if (!isValidInvite(v)) {
      return "Enter a valid email or wallet address.";
    }
    return null;
  };
  const allValid = rows.every(
    (row) =>
      isValidInvite(row.value) && !(isSelf(row.value) || dupIds.has(row.id))
  );

  const updateRow = (id: string, patch: Partial<InviteRow>): void => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row))
    );
  };

  // Wallet invitees have no inbox; resolve the sign-in address to that account's
  // synthetic email, then invite by email so the existing flow is reused.
  const resolveWalletEmail = async (
    address: string
  ): Promise<string | null> => {
    if (!organization?.id) {
      return null;
    }
    const res = await fetch(
      `/api/organizations/${organization.id}/wallet-lookup?address=${address}`,
      { cache: "no-store" }
    );
    const data = (await res.json().catch(() => ({}))) as {
      found?: boolean;
      email?: string;
      alreadyMember?: boolean;
      error?: string;
    };
    if (!(res.ok && data.found && data.email)) {
      toast.error(data.error ?? `No account signs in with ${address} yet.`);
      return null;
    }
    if (data.alreadyMember) {
      toast.error(`${address} is already a member.`);
      return null;
    }
    return data.email;
  };

  const sendInvite = async (row: InviteRow): Promise<boolean> => {
    const value = row.value.trim();
    const email = isAddress(value) ? await resolveWalletEmail(value) : value;
    if (!email) {
      return false;
    }
    const { error } = await authClient.organization.inviteMember({
      email,
      role: row.role,
      ...(organization?.id ? { organizationId: organization.id } : {}),
    });
    if (error) {
      toast.error(error.message || `Could not invite ${value}`);
      return false;
    }
    return true;
  };

  // Next is only enabled when every row is a valid, unique invite, so here we
  // just send them. Users who don't want to invite anyone use Skip instead.
  const handleNext = async (): Promise<void> => {
    setSending(true);
    try {
      let sent = 0;
      for (const row of rows) {
        if (await sendInvite(row)) {
          sent += 1;
        }
      }
      if (sent > 0) {
        toast.success(`Sent ${sent} invitation${sent === 1 ? "" : "s"}`);
      }
      router.push(NEXT_PATH);
    } finally {
      setSending(false);
    }
  };

  return (
    <WelcomeShell
      busy={sending}
      description="Add teammates by email or wallet address. They can also be invited later from settings."
      nextDisabled={!allValid}
      onBack={() => router.push(BACK_PATH)}
      onNext={handleNext}
      onSkip={() => router.push(NEXT_PATH)}
      preview={
        <InvitePreview
          invitees={rows
            .filter((row) => row.value.trim().length > 0)
            .map((row) => ({ label: row.value.trim(), role: row.role }))}
          orgName={organization?.name ?? "Your Organization"}
          ownerLabel={ownerLabel}
        />
      }
      stepIndex={1}
      title="Invite your team"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="flex-1">Email or wallet address</span>
            <span className="w-28 shrink-0">Role</span>
            <span className="size-9 shrink-0" />
          </div>
          {rows.map((row) => {
            const error = rowError(row);
            return (
              <div className="flex flex-col gap-1" key={row.id}>
                <div className="flex items-center gap-2">
                  <Input
                    className={cn(
                      "flex-1",
                      error &&
                        "border-destructive focus-visible:ring-destructive"
                    )}
                    onChange={(e) =>
                      updateRow(row.id, { value: e.target.value })
                    }
                    placeholder="Email or wallet address"
                    value={row.value}
                  />
                  <Select
                    onValueChange={(v) =>
                      updateRow(row.id, { role: v as InviteRole })
                    }
                    value={row.role}
                  >
                    <SelectTrigger className="w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    aria-label="Remove"
                    className={rows.length > 1 ? "" : "invisible"}
                    onClick={() =>
                      setRows((current) =>
                        current.filter((r) => r.id !== row.id)
                      )
                    }
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                {error ? (
                  <p className="text-destructive text-xs">{error}</p>
                ) : null}
              </div>
            );
          })}
        </div>
        <Button
          className="w-fit"
          disabled={!allValid}
          onClick={() => setRows((current) => [...current, newRow()])}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="size-4" />
          Add another
        </Button>
      </div>
    </WelcomeShell>
  );
}
