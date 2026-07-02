"use client";

import { useState } from "react";
import { SignInChoices } from "@/components/auth/sign-in-choices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * In-app "Connect" entry point. Opens a modal presenting the same single-column
 * sign-in interface as the welcome page (email + social, plus a wallet reveal).
 */
export function ConnectButton(): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="h-9" size="sm" variant="default">
          Connect
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-center">
            Sign in to KeeperHub
          </DialogTitle>
        </DialogHeader>
        <SignInChoices />
      </DialogContent>
    </Dialog>
  );
}
