"use client";

import { ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  next: string;
};

export function VerifyMfaForm({ next }: Props): React.ReactElement {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const trimmed = code.trim();
    if (trimmed.length < 6) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/user/totp/verify-stepup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(data.error ?? "Invalid code");
        setCode("");
        return;
      }
      router.replace(next || "/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardContent className="space-y-5 pt-6">
        <div className="flex items-start gap-3">
          <ShieldAlert
            aria-hidden="true"
            className="mt-0.5 size-5 text-amber-500"
          />
          <div className="space-y-1">
            <h1 className="font-medium text-lg">Confirm it's you</h1>
            <p className="text-muted-foreground text-sm">
              We noticed this sign-in is from a new location. Enter a code from
              your authenticator app to continue.
            </p>
          </div>
        </div>

        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="stepup-code">Authenticator code</Label>
            <Input
              autoComplete="one-time-code"
              autoFocus
              id="stepup-code"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              value={code}
            />
          </div>
          <Button
            className="w-full"
            disabled={busy || code.trim().length < 6}
            type="submit"
          >
            {busy ? "Verifying..." : "Verify"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
