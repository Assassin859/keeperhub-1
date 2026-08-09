"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth-client";
import { roleLabel } from "@/lib/organization/role-label";
import { useSettingsContext } from "./settings-context";

export function SettingsTopBar(): React.ReactElement {
  const router = useRouter();
  const { data: session } = useSession();
  const { role, roleLoading } = useSettingsContext();

  const displayName = session?.user?.name || session?.user?.email || "User";
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-sidebar px-5">
      <Button
        className="h-8 gap-1.5 px-2.5"
        data-testid="settings-exit"
        onClick={() => router.push("/")}
        size="sm"
        variant="outline"
      >
        <ArrowLeft className="size-3.5" />
        Exit settings
      </Button>
      <div className="ml-auto flex items-center gap-2.5 text-muted-foreground text-xs">
        <span className="hidden sm:inline">Signed in as</span>
        <span className="max-w-[180px] truncate font-medium text-foreground">
          {displayName}
        </span>
        {roleLoading && <Skeleton className="h-5 w-14 rounded-full" />}
        {!roleLoading && role && (
          <span className="rounded-full border px-2 py-0.5 text-[0.6875rem]">
            {roleLabel(role)}
          </span>
        )}
        <Avatar className="size-7">
          <AvatarImage
            alt={session?.user?.name ?? ""}
            src={session?.user?.image ?? ""}
          />
          <AvatarFallback className="text-[0.625rem]">
            {initials}
          </AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
