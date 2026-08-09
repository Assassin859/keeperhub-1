"use client";

import { Skeleton } from "@/components/ui/skeleton";

const KEYS = ["a", "b", "c", "d", "e", "f"] as const;

export function FormSkeleton({ rows = 2 }: { rows?: number }): React.ReactNode {
  return (
    <div className="space-y-5">
      {KEYS.slice(0, rows).map((key) => (
        <div className="space-y-2" key={key}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

export function RowsSkeleton({ rows = 4 }: { rows?: number }): React.ReactNode {
  return (
    <div className="space-y-2">
      {KEYS.slice(0, rows).map((key) => (
        <div
          className="flex items-center gap-3 rounded-lg border px-3 py-3"
          key={key}
        >
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-48" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function CardGridSkeleton({
  cards = 3,
}: {
  cards?: number;
}): React.ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {KEYS.slice(0, cards).map((key) => (
        <div className="space-y-4 rounded-xl border p-4" key={key}>
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          </div>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}

export function StatTilesSkeleton({
  tiles = 3,
}: {
  tiles?: number;
}): React.ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {KEYS.slice(0, tiles).map((key) => (
        <div className="space-y-2 rounded-xl border p-4" key={key}>
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-6 w-14" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      ))}
    </div>
  );
}
