"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { TotpSetupDialog } from "@/components/settings/totp-setup-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  STEP_UP_ACTIONS,
  type StepUpFactor,
} from "@/lib/mfa/step-up-policy";
import {
  runWalletStepUp,
  type StepUpExtra,
} from "@/lib/wallet/step-up-client";

type Enrolled = { wallet: boolean; totp: boolean; email: boolean };
type Policy = Record<string, StepUpFactor[]>;

type PolicyResponse = {
  walletUser: boolean;
  policy: Policy;
  enrolled: Enrolled;
};

// Actions a wallet user can harden, with friendly labels. Wallet signature is
// always required; these toggles add TOTP / email on top.
const CONFIGURABLE_ACTIONS: { action: string; label: string }[] = [
  { action: STEP_UP_ACTIONS.walletWithdraw, label: "Withdraw funds" },
  { action: STEP_UP_ACTIONS.walletExportKey, label: "Export wallet key" },
  { action: STEP_UP_ACTIONS.apiKeyCreate, label: "Create an API key" },
];

const FACTOR_LABELS: Record<Exclude<StepUpFactor, "wallet">, string> = {
  totp: "Authenticator",
  email: "Email code",
};

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

  const send = async (body: Record<string, string>): Promise<Response> =>
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
      onOpenChange(false);
      setEmail("");
      setCode("");
      setPhase("email");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a step-up email</DialogTitle>
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

export function WalletSecuritySection(): React.ReactElement {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [addEmailOpen, setAddEmailOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/user/step-up/policy");
    if (res.ok) {
      setData((await res.json()) as PolicyResponse);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const disableEmail = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await runWalletStepUp((extra: StepUpExtra) =>
        fetch("/api/user/step-up/email", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(extra),
        })
      );
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Step-up email removed.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const disableTotp = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await runWalletStepUp((extra: StepUpExtra) =>
        fetch("/api/user/totp/disable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(extra),
        })
      );
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Authenticator disabled.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggleActionFactor = async (
    action: string,
    factor: Exclude<StepUpFactor, "wallet">
  ): Promise<void> => {
    if (!data) {
      return;
    }
    const current = new Set(data.policy[action] ?? []);
    if (current.has(factor)) {
      current.delete(factor);
    } else {
      current.add(factor);
    }
    const factors = [...current];
    setBusy(true);
    try {
      const res = await runWalletStepUp((extra: StepUpExtra) =>
        fetch("/api/user/step-up/policy", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, factors, ...extra }),
        })
      );
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium text-sm">Extra confirmation factors</h3>
        <p className="text-muted-foreground text-sm">
          Your wallet signature confirms every sensitive action. Add an
          authenticator or email for extra protection, then require them per
          action below.
        </p>
      </div>

      <Card className="border py-0 shadow-none">
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="font-medium text-sm">Authenticator (TOTP)</p>
            <p className="text-muted-foreground text-xs">
              {data.enrolled.totp ? "Enrolled" : "Not set up"}
            </p>
          </div>
          <Switch
            checked={data.enrolled.totp}
            disabled={busy}
            onCheckedChange={(next) => {
              if (next) {
                setSetupOpen(true);
              } else {
                disableTotp();
              }
            }}
          />
        </CardContent>
      </Card>

      <Card className="border py-0 shadow-none">
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="font-medium text-sm">Email code</p>
            <p className="text-muted-foreground text-xs">
              {data.enrolled.email ? "Verified email on file" : "Not added"}
            </p>
          </div>
          <Switch
            checked={data.enrolled.email}
            disabled={busy}
            onCheckedChange={(next) => {
              if (next) {
                setAddEmailOpen(true);
              } else {
                disableEmail();
              }
            }}
          />
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h3 className="font-medium text-sm">Require for specific actions</h3>
        <p className="text-muted-foreground text-sm">
          Turning a factor on is instant; turning one off asks you to sign
          first.
        </p>
        <div className="space-y-2">
          {CONFIGURABLE_ACTIONS.map(({ action, label }) => {
            const selected = new Set(data.policy[action] ?? []);
            return (
              <Card className="border py-0 shadow-none" key={action}>
                <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <span className="font-medium text-sm">{label}</span>
                  <div className="flex items-center gap-5">
                    {(["totp", "email"] as const).map((factor) => {
                      const enrolled = data.enrolled[factor];
                      const active = selected.has(factor);
                      return (
                        <div className="flex items-center gap-2" key={factor}>
                          <span className="text-muted-foreground text-xs">
                            {FACTOR_LABELS[factor]}
                          </span>
                          <Switch
                            checked={active}
                            disabled={busy || !enrolled}
                            onCheckedChange={() =>
                              toggleActionFactor(action, factor)
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <TotpSetupDialog
        onEnrolled={load}
        onOpenChange={(next) => {
          setSetupOpen(next);
          if (!next) {
            load();
          }
        }}
        open={setupOpen}
      />
      <AddEmailDialog
        onAdded={load}
        onOpenChange={setAddEmailOpen}
        open={addEmailOpen}
      />
    </div>
  );
}
