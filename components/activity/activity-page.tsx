"use client";

import { Download, Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { AuditFilterBar } from "@/components/activity/audit-filter-bar";
import { ExportAuditOverlay } from "@/components/overlays/export-audit-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/**
 * Full-page organization activity feed. Mirrors the body of ActivityOverlay but
 * in page chrome, reachable at /activity from the left nav. Admin/owner only --
 * the read endpoint is gated the same way server-side, and anyone without that
 * role who lands here by URL is bounced home rather than shown an empty page.
 */
export function ActivityPage(): ReactNode {
  const { data: session, isPending } = useSession();
  const { isAdmin, isOwner, isLoading } = useActiveMember();
  const { push } = useOverlay();
  const router = useRouter();
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

  // Admin/owner only. Once auth + membership resolve, bounce anyone else home;
  // the server already 403s the data, this just keeps them off the page.
  const resolved = !(isPending || isLoading);
  const allowed =
    Boolean(session?.user) && !session?.user?.isAnonymous && isAdmin;
  useEffect(() => {
    if (resolved && !allowed) {
      router.replace("/");
    }
  }, [resolved, allowed, router]);

  if (!(resolved && allowed)) {
    return null;
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
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <div className="relative w-full max-w-xs">
                <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-sm"
                  onChange={(e) => activity.setSearchText(e.target.value)}
                  placeholder="Search name, email, workflow, IP..."
                  value={activity.searchText}
                />
              </div>
              <AuditFilterBar activity={activity} />
            </div>
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
