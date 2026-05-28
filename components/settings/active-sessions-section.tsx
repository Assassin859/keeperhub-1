"use client";

import { Laptop, Monitor, Smartphone, Tablet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";

type SessionRow = {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  location: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; rows: SessionRow[] }
  | { kind: "error"; message: string };

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "Unknown";
  }
  const deltaSeconds = Math.round((then - Date.now()) / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  if (absSeconds < 60) {
    return RELATIVE_TIME.format(deltaSeconds, "second");
  }
  if (absSeconds < 3600) {
    return RELATIVE_TIME.format(Math.round(deltaSeconds / 60), "minute");
  }
  if (absSeconds < 86_400) {
    return RELATIVE_TIME.format(Math.round(deltaSeconds / 3600), "hour");
  }
  return RELATIVE_TIME.format(Math.round(deltaSeconds / 86_400), "day");
}

function describeUserAgent(ua: string | null): {
  label: string;
  icon: typeof Laptop;
} {
  if (!ua) {
    return { label: "Unknown device", icon: Monitor };
  }
  const lower = ua.toLowerCase();
  const isMobile = /iphone|android.*mobile/.test(lower);
  const isTablet = /ipad|android(?!.*mobile)/.test(lower);
  const browser = lower.includes("firefox")
    ? "Firefox"
    : lower.includes("edg/")
      ? "Edge"
      : lower.includes("chrome")
        ? "Chrome"
        : lower.includes("safari")
          ? "Safari"
          : "Browser";
  const os = lower.includes("mac os x")
    ? "macOS"
    : lower.includes("windows")
      ? "Windows"
      : lower.includes("linux")
        ? "Linux"
        : lower.includes("iphone") || lower.includes("ipad")
          ? "iOS"
          : lower.includes("android")
            ? "Android"
            : "Unknown OS";
  const icon = isMobile ? Smartphone : isTablet ? Tablet : Laptop;
  return { label: `${browser} on ${os}`, icon };
}

export function ActiveSessionsSection(): React.ReactElement {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [revokeTarget, setRevokeTarget] = useState<SessionRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const dual = useDualFactorState();

  useEffect(() => {
    if (!copiedRowId) {
      return;
    }
    const timer = window.setTimeout(() => setCopiedRowId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedRowId]);

  const handleCopyIp = async (row: SessionRow): Promise<void> => {
    if (!row.ipAddress || typeof navigator === "undefined") {
      return;
    }
    try {
      await navigator.clipboard.writeText(row.ipAddress);
      setCopiedRowId(row.id);
      toast.success("IP copied to clipboard");
    } catch {
      toast.error("Couldn't copy IP");
    }
  };

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/user/sessions", { cache: "no-store" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: "error",
          message: data.error ?? "Couldn't load sessions",
        });
        return;
      }
      const data = (await res.json()) as { sessions: SessionRow[] };
      setState({ kind: "ready", rows: data.sessions });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Couldn't load sessions",
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const closeDialog = useCallback((): void => {
    setRevokeTarget(null);
    dual.reset();
  }, [dual]);

  const handleRevoke = async (): Promise<void> => {
    if (!revokeTarget || busy) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/user/sessions/${revokeTarget.id}/revoke`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: dual.totpCode.trim(),
            emailOtp: dual.emailOtp.trim() || undefined,
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        toast.error(data.error ?? "Failed to revoke session");
        return;
      }
      toast.success("Session revoked");
      closeDialog();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const emptyCodesFetch = (): Promise<Response> =>
    fetch(`/api/user/sessions/${revokeTarget?.id ?? ""}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  return (
    <Card className="border-0 py-0 shadow-none">
      <CardContent className="space-y-3 p-0">
        <div className="space-y-1">
          <h3 className="font-medium text-sm">Active sessions</h3>
          <p className="text-muted-foreground text-xs">
            Every device signed in to this account. Revoke any session you
            don't recognise. Revoking requires a code from your email and
            your authenticator.
          </p>
        </div>

        {state.kind === "loading" && (
          <div className="flex items-center justify-center py-6">
            <Spinner />
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-xs">
            {state.message}
          </div>
        )}

        {state.kind === "ready" &&
          state.rows.map((row) => {
            const ua = describeUserAgent(row.userAgent);
            const Icon = ua.icon;
            return (
              <div
                className="flex items-start gap-3 rounded-md border bg-muted/30 p-3"
                key={row.id}
              >
                <Icon
                  aria-hidden="true"
                  className="mt-0.5 size-4 text-muted-foreground"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{ua.label}</span>
                    {row.isCurrent && (
                      <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
                        This device
                      </Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {row.ipAddress ? (
                      <button
                        className={`font-mono transition-colors ${
                          copiedRowId === row.id
                            ? "text-emerald-500"
                            : "hover:text-foreground"
                        }`}
                        onClick={() => handleCopyIp(row)}
                        title="Copy IP to clipboard"
                        type="button"
                      >
                        {row.ipAddress}
                      </button>
                    ) : (
                      "IP unknown"
                    )}
                    {row.location ? ` · ${row.location}` : ""}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Signed in {relativeTime(row.createdAt)} · last active{" "}
                    {relativeTime(row.updatedAt)}
                  </div>
                </div>
                {!row.isCurrent && (
                  <Button
                    onClick={() => {
                      dual.reset();
                      setRevokeTarget(row);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Revoke
                  </Button>
                )}
              </div>
            );
          })}
      </CardContent>

      <Dialog
        onOpenChange={(next) => {
          if (!next) {
            closeDialog();
          }
        }}
        open={revokeTarget !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke this session</DialogTitle>
            <DialogDescription>
              {revokeTarget
                ? `Sign out ${describeUserAgent(revokeTarget.userAgent).label} (${revokeTarget.ipAddress ?? "unknown IP"}). Confirm with both factors to continue.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {revokeTarget && (
            <DualFactorSteps
              busy={busy}
              dual={dual}
              onBack={closeDialog}
              onPrefetchEmail={() => dual.prefetchEmail(emptyCodesFetch)}
              onResendEmail={() => dual.resendEmail(emptyCodesFetch)}
              onSubmit={handleRevoke}
              submitLabel="Revoke session"
              submitVariant="destructive"
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
