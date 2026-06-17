"use client";

import { Activity, Download, LogIn } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { AuditFilterBar } from "@/components/activity/audit-filter-bar";
import { ExportAuditOverlay } from "@/components/overlays/export-audit-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/lib/auth-client";
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  useAuditActivity,
} from "@/lib/hooks/use-audit-activity";
import { useActiveMember } from "@/lib/hooks/use-organization";

function Gate({
  icon,
  title,
  description,
  showCta,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  showCta: boolean;
}): ReactNode {
  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        <div className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
            {icon}
          </div>
          <div className="space-y-2">
            <h2 className="font-semibold text-xl tracking-tight">{title}</h2>
            <p className="max-w-sm text-muted-foreground text-sm">
              {description}
            </p>
          </div>
          {showCta && (
            <Button asChild>
              <Link href="/">Get Started</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Full-page organization activity feed. Mirrors the body of ActivityOverlay but
 * in page chrome, reachable at /activity from the left nav. Admin/owner only --
 * the read endpoint is gated the same way server-side; non-admins who land here
 * by URL get a gate rather than a stream of 403s.
 */
export function ActivityPage(): ReactNode {
  const { data: session, isPending } = useSession();
  const { isAdmin, isOwner, isLoading } = useActiveMember();
  const { push } = useOverlay();
  const searchParams = useSearchParams();
  // Seed page size from the URL so a shared/refreshed ?size=N is honored; an
  // out-of-range value falls back to the default.
  const sizeParam = Number.parseInt(searchParams.get("size") ?? "", 10);
  const initialPageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(
    sizeParam
  )
    ? sizeParam
    : DEFAULT_AUDIT_PAGE_SIZE;
  const activity = useAuditActivity({ initialPageSize });

  if (isPending || isLoading) {
    return null;
  }

  const isAnonymous = !session?.user || session.user.isAnonymous;
  if (isAnonymous) {
    return (
      <Gate
        description="Sign in to your account to view your organization's activity."
        icon={<LogIn className="size-10 text-muted-foreground" />}
        showCta={false}
        title="Sign in to view activity"
      />
    );
  }

  if (!isAdmin) {
    return (
      <Gate
        description="Only organization admins and owners can view activity."
        icon={<Activity className="size-10 text-muted-foreground" />}
        showCta={false}
        title="Admins only"
      />
    );
  }

  return (
    <div className="pointer-events-auto fixed inset-0 flex flex-col overflow-hidden bg-sidebar">
      <div className="flex min-h-0 flex-1 flex-col transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        <div className="flex min-h-0 flex-1 flex-col gap-6 p-6 pt-[calc(5rem+var(--app-banner-height,0px))]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="font-semibold text-2xl tracking-tight">
                Organization activity
              </h1>
              <p className="text-muted-foreground text-sm">
                Recent security-sensitive actions across your organization.
              </p>
            </div>
            <Button
              disabled={!isOwner}
              onClick={() =>
                push(ExportAuditOverlay, {
                  resourceTypes: activity.types,
                })
              }
              size="sm"
              title={
                isOwner ? undefined : "Only organization owners can export"
              }
              variant="outline"
            >
              <Download className="mr-2 size-4" />
              Export CSV
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <AuditFilterBar activity={activity} />
            <Select
              onValueChange={(v) => activity.setPageSize(Number(v))}
              value={String(activity.pageSize)}
            >
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ActivityFeed
            fillHeight
            params={activity.feedParams}
            syncPageToUrl
            urlPageSizeDefault={DEFAULT_AUDIT_PAGE_SIZE}
          />
        </div>
      </div>
    </div>
  );
}
