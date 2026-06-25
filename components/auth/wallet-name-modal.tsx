"use client";

import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { useSession } from "@/lib/auth-client";
import { generateHandle } from "@/lib/utils/wallet-handle";

/**
 * First-login rename step for wallet sign-in accounts. The account already has
 * a randomly generated handle, so the audit trail never shows a 0x address;
 * this lets the user keep it, regenerate a new random one, or type their own.
 * Required: it cannot be dismissed until a name is saved.
 */
export function WalletNameModal(): React.ReactElement | null {
  const { data: session, refetch } = useSession();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const user = session?.user;
  const isWallet = isWalletEmail(user?.email);
  const needsName =
    Boolean(user) &&
    isWallet &&
    (user as { displayNameConfirmed?: boolean | null }).displayNameConfirmed !==
      true;

  // Seed the input with a random name the first time we open: the
  // server-assigned handle if present, otherwise a freshly generated one.
  useEffect(() => {
    if (needsName) {
      setName((current) => current || user?.name || generateHandle());
    }
  }, [needsName, user?.name]);

  if (!needsName) {
    return null;
  }

  const regenerate = (): void => {
    setName(generateHandle());
  };

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Please enter a name.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/user/display-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "Could not save your name.");
        return;
      }
      await refetch();
      toast.success("Welcome to KeeperHub!");
    } catch {
      toast.error("Could not save your name.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Choose a display name</DialogTitle>
          <DialogDescription>
            This is how you appear across KeeperHub and in audit history. Keep
            the random name, regenerate a new one, or enter your own.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="wallet-display-name">Display name</Label>
            <div className="flex items-center gap-2">
              <Input
                className="flex-1"
                id="wallet-display-name"
                maxLength={50}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Swift Falcon"
                value={name}
              />
              <Button
                aria-label="Regenerate name"
                onClick={regenerate}
                size="icon"
                title="Regenerate"
                type="button"
                variant="outline"
              >
                <RotateCw className="size-4" />
              </Button>
            </div>
          </div>
          <Button
            className="w-full"
            disabled={saving || name.trim().length === 0}
            onClick={save}
            type="button"
          >
            {saving ? <Spinner /> : "Continue"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
