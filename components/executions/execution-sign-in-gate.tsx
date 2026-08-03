"use client";

import { useAuthPrompt } from "@/components/auth/provider";
import { Button } from "@/components/ui/button";

export function ExecutionSignInGate(): React.ReactElement {
  const { openAuthPrompt } = useAuthPrompt();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <h1 className="font-semibold text-xl">Sign in to continue</h1>
        <p className="text-muted-foreground text-sm">
          This page requires a KeeperHub account. Sign in to view the execution
          details.
        </p>
        <Button onClick={() => openAuthPrompt()}>Sign in</Button>
      </div>
    </main>
  );
}
