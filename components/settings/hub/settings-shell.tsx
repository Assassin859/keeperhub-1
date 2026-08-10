"use client";

import type { ReactNode } from "react";
import { SettingsRail } from "./settings-rail";

export function SettingsShell({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return (
    <div
      className="pointer-events-auto fixed inset-x-0 bottom-0 flex flex-col bg-background"
      data-testid="settings-shell"
      // Sits directly under the shared app toolbar, which is fixed at the top
      // of every route.
      style={{
        top: "calc(var(--header-height, 60px) + var(--app-banner-height, 0px))",
      }}
    >
      <div className="flex min-h-0 flex-1">
        <SettingsRail />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
