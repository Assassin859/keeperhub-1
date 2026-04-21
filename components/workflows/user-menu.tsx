"use client";

import {
  CreditCard,
  FolderTree,
  Key,
  LogOut,
  Plug,
  Settings,
  Users,
  Wallet,
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
import { WalletOverlay } from "@/components/overlays/wallet-overlay";
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
import { useActiveMember, useOrganization } from "@/lib/hooks/use-organization";

export const UserMenu = (): React.ReactElement => {
  const { data: session, isPending } = useSession();
  const { open: openOverlay } = useOverlay();
  const [orgModalOpen, setOrgModalOpen] = useState(false);
  const { organization } = useOrganization();
  const { isOwner } = useActiveMember();
  const router = useRouter();
  const showBilling = isOwner && isBillingEnabled();

  const handleLogout = async () => {
    await signOut();
    // Full page refresh to clear all React/jotai state
    window.location.href = "/";
  };

  const getUserInitials = () => {
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

  // Show Sign In button if user is anonymous, not logged in, or email not verified
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="User menu"
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
          <DropdownMenuItem onClick={() => openOverlay(WalletOverlay)}>
            <Wallet className="size-4" />
            <span>Wallet</span>
          </DropdownMenuItem>
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
              <span>Billing</span>
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
