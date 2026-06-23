"use client";

import { Check, Mail, ShieldCheck, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { TotpSetupDialog } from "@/components/settings/totp-setup-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { StepUpFactor } from "@/lib/mfa/step-up-policy";

type Enrolled = { totp: boolean; email: boolean };

async function readError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "Something went wrong.";
}

function AddEmailDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}): React.ReactElement {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"email" | "code">("email");
  const [loading, setLoading] = useState(false);

  const send = (body: Record<string, string>): Promise<Response> =>
    fetch("/api/user/step-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const requestCode = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await send({ email: email.trim() });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      setPhase("code");
      toast.success("Verification code sent.");
    } finally {
      setLoading(false);
    }
  };

  const verify = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await send({ email: email.trim(), code: code.trim() });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Email added.");
      onAdded();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a verified email</DialogTitle>
          <DialogDescription>
            {phase === "email"
              ? "We'll send a code to confirm this inbox."
              : `Enter the code we sent to ${email}.`}
          </DialogDescription>
        </DialogHeader>
        {phase === "email" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              requestCode();
            }}
          >
            <Input
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
            <Button disabled={loading} type="submit">
              {loading ? <Spinner className="size-4" /> : "Send code"}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <Input
              inputMode="numeric"
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              value={code}
            />
            <Button disabled={loading} type="submit">
              {loading ? <Spinner className="size-4" /> : "Verify"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function EnforceMfaForm({
  required,
  enrolled,
  orgName,
  next,
}: {
  required: StepUpFactor[];
  enrolled: Enrolled;
  orgName: string;
  next: string;
}): React.ReactElement {
  const router = useRouter();
  const [totpOpen, setTotpOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const acceptsTotp = required.includes("totp");
  const acceptsEmail = required.includes("email");

  // Enrolling any accepted factor satisfies the gate; bounce back to where they
  // were headed and let the proxy re-check (it will now pass them through).
  const onEnrolled = (): void => {
    setTotpOpen(false);
    setEmailOpen(false);
    toast.success("Second factor added.");
    router.replace(next);
    router.refresh();
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
        </div>
        <CardTitle>Two-factor required</CardTitle>
        <CardDescription>
          {orgName} requires every member to secure their account with a second
          factor. Add one of the options below to continue.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {acceptsTotp && (
          <button
            className="flex w-full items-center gap-3 rounded-md border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
            disabled={enrolled.totp}
            onClick={() => setTotpOpen(true)}
            type="button"
          >
            <Smartphone
              aria-hidden="true"
              className="size-5 text-muted-foreground"
            />
            <div className="flex-1">
              <div className="font-medium text-sm">Authenticator app</div>
              <div className="text-muted-foreground text-xs">
                Use an app like 1Password or Google Authenticator.
              </div>
            </div>
            {enrolled.totp ? (
              <Check aria-hidden="true" className="size-4 text-emerald-500" />
            ) : (
              <span className="text-primary text-xs">Set up</span>
            )}
          </button>
        )}
        {acceptsEmail && (
          <button
            className="flex w-full items-center gap-3 rounded-md border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
            disabled={enrolled.email}
            onClick={() => setEmailOpen(true)}
            type="button"
          >
            <Mail aria-hidden="true" className="size-5 text-muted-foreground" />
            <div className="flex-1">
              <div className="font-medium text-sm">Verified email</div>
              <div className="text-muted-foreground text-xs">
                Receive confirmation codes at an inbox you control.
              </div>
            </div>
            {enrolled.email ? (
              <Check aria-hidden="true" className="size-4 text-emerald-500" />
            ) : (
              <span className="text-primary text-xs">Add</span>
            )}
          </button>
        )}
      </CardContent>

      <TotpSetupDialog
        onEnrolled={onEnrolled}
        onOpenChange={setTotpOpen}
        open={totpOpen}
      />
      <AddEmailDialog
        onAdded={onEnrolled}
        onOpenChange={setEmailOpen}
        open={emailOpen}
      />
    </Card>
  );
}
