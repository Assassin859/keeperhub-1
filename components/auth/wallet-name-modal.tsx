"use client";

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
import { generateHandlePair } from "@/lib/utils/wallet-handle";

/**
 * First-login rename step for wallet (SIWE) accounts. The account already has
 * a generated handle, so the audit trail never shows a 0x address; this lets
 * the user confirm it, pick the alternate suggestion, regenerate, or type
 * their own. Required: it cannot be dismissed until a name is saved.
 */
export function WalletNameModal(): React.ReactElement | null {
  const { data: session, refetch } = useSession();
  const [suggestions, setSuggestions] = useState<[string, string]>(() =>
    generateHandlePair()
  );
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const user = session?.user;
  const isWallet = isWalletEmail(user?.email);
  const needsName =
    Boolean(user) &&
    isWallet &&
    (user as { displayNameConfirmed?: boolean | null }).displayNameConfirmed !==
      true;

  // Seed the input with the server-assigned handle the first time we open.
  useEffect(() => {
    if (needsName && user?.name) {
      setName((current) => current || user.name || "");
    }
  }, [needsName, user?.name]);

  if (!needsName) {
    return null;
  }

  const regenerate = (): void => {
    setSuggestions(generateHandlePair());
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
            This is how you appear across KeeperHub and in audit history. Pick a
            suggestion or enter your own.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                onClick={() => setName(suggestion)}
                size="sm"
                type="button"
                variant={name === suggestion ? "default" : "outline"}
              >
                {suggestion}
              </Button>
            ))}
            <Button
              onClick={regenerate}
              size="sm"
              type="button"
              variant="ghost"
            >
              Regenerate
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="wallet-display-name">Display name</Label>
            <Input
              id="wallet-display-name"
              maxLength={50}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Swift Falcon"
              value={name}
            />
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
