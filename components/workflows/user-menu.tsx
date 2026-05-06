"use client";

import {
  CreditCard,
  FolderTree,
  Key,
  LogOut,
  Plug,
  Settings,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AuthDialog,
  isSingleProviderSignInInitiated,
} from "@/components/auth/dialog";
import { ManageOrgsModal } from "@/components/organization/manage-orgs-modal";
import { ApiKeysOverlay } from "@/components/overlays/api-keys-overlay";
import { IntegrationsOverlay } from "@/components/overlays/integrations-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { ProjectsAndTagsOverlay } from "@/components/overlays/projects-and-tags-overlay";
import { SettingsOverlay } from "@/components/overlays/settings-overlay";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut, useSession } from "@/lib/auth-client";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  hasNotificationType,
  useNotificationStatus,
} from "@/lib/hooks/use-notifications";
import { useActiveMember, useOrganization } from "@/lib/hooks/use-organization";

export const UserMenu = (): React.ReactElement => {
  const { data: session, isPending } = useSession();
  const signInInProgress = isSingleProviderSignInInitiated();

  // Check if user is anonymous
  // Better Auth anonymous plugin creates users with name "Anonymous" and temp- email
  const isAnonymousUser =
    !session?.user ||
    session.user.name === "Anonymous" ||
    session.user.email?.startsWith("temp-");

  // Check if user's email is verified
  const isEmailVerified = session?.user?.emailVerified === true;

  // Don't render anything while session is loading to prevent flash
  // BUT if sign-in is in progress, keep showing the AuthDialog with loading state
  if (isPending && !signInInProgress) {
    return (
      <div className="h-9 w-9" /> // Placeholder to maintain layout
    );
  }

  // NAV-04: only mount the authenticated dropdown when the user is signed in
  // and verified. The dropdown depends on `useOrganization` and
  // `useActiveMember`, which auto-fire protected fetches as soon as they are
  // called. Routing anonymous users through a separate sign-in surface keeps
  // the network log clean on initial load.
  if (isAnonymousUser || !isEmailVerified) {
    return (
      <div className="flex items-center gap-2">
        <AuthDialog>
          <Button
            className="h-9 disabled:opacity-100 disabled:*:text-muted-foreground"
            size="sm"
            variant="default"
          >
            Sign In
          </Button>
        </AuthDialog>
      </div>
    );
  }

  return <AuthenticatedUserMenu />;
};

const AuthenticatedUserMenu = (): React.ReactElement => {
  const { data: session } = useSession();
  const { open: openOverlay } = useOverlay();
  const [orgModalOpen, setOrgModalOpen] = useState(false);
  const { organization } = useOrganization();
  const { isOwner } = useActiveMember();
  const router = useRouter();
  const showBilling = isOwner && isBillingEnabled();
  const { status: notificationStatus, refresh: refreshNotifications } =
    useNotificationStatus(organization?.id);
  const showAvatarDot = notificationStatus.unreadCount > 0;
  const showBillingDot = hasNotificationType(
    notificationStatus,
    "billing_limit_reached"
  );

  const handleDropdownOpenChange = (open: boolean): void => {
    if (open) {
      refreshNotifications().catch(() => undefined);
    }
  };

  const handleLogout = async (): Promise<void> => {
    await signOut();
    // Full page refresh to clear all React/jotai state
    window.location.href = "/";
  };

  const getUserInitials = (): string => {
    if (session?.user?.name) {
      return session.user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    if (session?.user?.email) {
      return session.user.email.slice(0, 2).toUpperCase();
    }
    return "U";
  };

  return (
    <>
      <DropdownMenu onOpenChange={handleDropdownOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={
              showAvatarDot ? "User menu, unread notifications" : "User menu"
            }
            className="relative h-9 w-9 rounded-full border p-0"
            data-testid="user-menu"
            variant="ghost"
          >
            <Avatar className="h-9 w-9">
              <AvatarImage
                alt={session?.user?.name || ""}
                src={session?.user?.image || ""}
              />
              <AvatarFallback>{getUserInitials()}</AvatarFallback>
            </Avatar>
            {showAvatarDot && (
              <span
                aria-hidden="true"
                className="absolute top-0 right-0 size-2.5 rounded-full bg-destructive ring-2 ring-background"
                data-testid="user-menu-notification-dot"
              />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="flex flex-col space-y-1">
              <p className="font-medium text-sm leading-none">
                {session?.user?.name || "User"}
              </p>
              <p className="text-muted-foreground text-xs leading-none">
                {session?.user?.email}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="lg:hidden">
            <DropdownMenuItem onClick={() => setOrgModalOpen(true)}>
              <Users className="size-4" />
              <span className="truncate">
                {organization?.name ?? "Organization"}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </div>
          <DropdownMenuItem onClick={() => openOverlay(SettingsOverlay)}>
            <Settings className="size-4" />
            <span>Settings</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openOverlay(IntegrationsOverlay)}>
            <Plug className="size-4" />
            <span>Connections</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openOverlay(ApiKeysOverlay)}>
            <Key className="size-4" />
            <span>API Keys</span>
          </DropdownMenuItem>
          {showBilling && (
            <DropdownMenuItem onClick={() => router.push("/billing")}>
              <CreditCard className="size-4" />
              <span className="flex-1">Billing</span>
              {showBillingDot && (
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-destructive"
                  data-testid="billing-notification-dot"
                />
              )}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => openOverlay(ProjectsAndTagsOverlay)}>
            <FolderTree className="size-4" />
            <span>Projects and Tags</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout}>
            <LogOut className="size-4" />
            <span>Logout</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ManageOrgsModal onOpenChange={setOrgModalOpen} open={orgModalOpen} />
    </>
  );
};
