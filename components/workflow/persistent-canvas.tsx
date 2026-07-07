"use client";

import { useAtomValue } from "jotai";
import { usePathname } from "next/navigation";
import { rootGateAtom } from "@/lib/onboarding/root-gate";
import { WorkflowCanvas } from "./workflow-canvas";

export function PersistentCanvas() {
  const pathname = usePathname();
  const rootGate = useAtomValue(rootGateAtom);

  // Workflow pages always render the canvas. On "/", only render once the
  // homepage gate has resolved to "canvas" -- while the session/onboarding
  // decision is pending or redirecting to the welcome flow the canvas is not
  // mounted at all, so it can never flash before a redirect.
  const showCanvas =
    pathname.startsWith("/workflows/") ||
    (pathname === "/" && rootGate === "canvas");

  if (!showCanvas) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-0">
      <WorkflowCanvas />
    </div>
  );
}
