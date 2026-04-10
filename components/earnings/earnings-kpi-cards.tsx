"use client";

import { useAtomValue } from "jotai";
import { Activity, DollarSign, TrendingUp } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { earningsDataAtom, earningsLoadingAtom } from "@/lib/atoms/earnings";
import { cn } from "@/lib/utils";

function SkeletonCard(): ReactNode {
  return (
    <Card>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-7 w-24 animate-pulse rounded bg-muted" />
          </div>
          <div className="size-10 animate-pulse rounded-lg bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

type KpiCardProps = {
  icon: ReactNode;
  label: string;
  value: string;
  subtext?: string;
  iconClassName?: string;
};

function KpiCard({
  icon,
  label,
  value,
  subtext,
  iconClassName,
}: KpiCardProps): ReactNode {
  return (
    <Card>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-semibold tracking-tight">{value}</p>
            {subtext ? (
              <p className="text-xs text-muted-foreground">{subtext}</p>
            ) : null}
          </div>
          <div
            className={cn(
              "flex size-10 items-center justify-center rounded-lg",
              iconClassName ?? "bg-primary/10 text-primary"
            )}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function EarningsKpiCards(): ReactNode {
  const data = useAtomValue(earningsDataAtom);
  const loading = useAtomValue(earningsLoadingAtom);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const {
    totalGrossRevenue,
    totalCreatorEarnings,
    totalInvocations,
    creatorSharePercent,
  } = data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          icon={<DollarSign className="size-5" />}
          iconClassName="bg-green-500/10 text-green-600 dark:text-green-400"
          label="Total Revenue"
          value={totalGrossRevenue}
        />
        <KpiCard
          icon={<TrendingUp className="size-5" />}
          iconClassName="bg-keeperhub-green/10 text-keeperhub-green-dark"
          label="Earnings"
          subtext={`(${creatorSharePercent}% of gross revenue)`}
          value={totalCreatorEarnings}
        />
        <KpiCard
          icon={<Activity className="size-5" />}
          iconClassName="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          label="Total Invocations"
          value={totalInvocations.toLocaleString()}
        />
      </div>
    </div>
  );
}
