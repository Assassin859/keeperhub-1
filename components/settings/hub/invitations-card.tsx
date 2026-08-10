"use client";

import { Mail, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "./section";
import { RowsSkeleton } from "./skeletons";

type InvitationRow = {
  id: string;
  label: string;
  badge?: string;
  expired?: boolean;
  /** Secondary line, e.g. when it was sent and when it lapses. */
  meta?: string;
};

export function InvitationsCard({
  title,
  description,
  rows,
  loading,
  emptyLabel,
  onCancel,
  onResend,
  reviewHref,
}: {
  title: string;
  description: string;
  rows: InvitationRow[];
  loading: boolean;
  emptyLabel: string;
  /** Admin surface: cancel a sent invitation. */
  onCancel?: (id: string) => void;
  /** Admin surface: cancel and issue a fresh invitation to the same address. */
  onResend?: (id: string) => void;
  /** Personal surface: link to the accept-invite page. */
  reviewHref?: (id: string) => string;
}): React.ReactElement {
  return (
    <SettingsCard description={description} title={title}>
      {loading && <RowsSkeleton rows={2} />}
      {!loading && rows.length === 0 && (
        <p className="text-muted-foreground text-sm">{emptyLabel}</p>
      )}
      {!loading && rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
              key={row.id}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm">{row.label}</span>
                    {row.badge && (
                      <span className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.625rem] uppercase">
                        {row.badge}
                      </span>
                    )}
                    {row.expired && (
                      <span className="shrink-0 rounded-full border border-amber-500/40 px-2 py-0.5 text-[0.6875rem] text-amber-400">
                        Expired
                      </span>
                    )}
                  </span>
                  {row.meta && (
                    <span className="truncate text-muted-foreground text-xs">
                      {row.meta}
                    </span>
                  )}
                </span>
              </span>
              {/* One group so the actions stay together at the right edge
                  instead of being spread across the row. */}
              <span className="flex shrink-0 items-center gap-1">
                {onResend && (
                  <Button
                    onClick={() => onResend(row.id)}
                    size="sm"
                    variant="ghost"
                  >
                    <RefreshCw className="size-3.5" />
                    Resend
                  </Button>
                )}
                {onCancel && (
                  <Button
                    onClick={() => onCancel(row.id)}
                    size="sm"
                    variant="ghost"
                  >
                    <X className="size-3.5" />
                    Cancel
                  </Button>
                )}
                {reviewHref && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={reviewHref(row.id)}>Review</Link>
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
