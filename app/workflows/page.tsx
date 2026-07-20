"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

// Index route for `/workflows` (no workflow selected). Without this the bare
// path 404s in the canvas. Redirects to the most recently created workflow so
// the canvas always has content; falls back to an empty state when the org has
// none. A digest-email deep link (`?digestSettings=`) opens a modal over this
// page, so we skip the redirect in that case to avoid navigating out from under
// it.
export default function WorkflowsIndexPage(): React.ReactElement | null {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasDeepLink = searchParams.get("digestSettings") !== null;
  const resolvedRef = useRef(false);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    if (hasDeepLink || resolvedRef.current) {
      return;
    }
    resolvedRef.current = true;

    const resolve = async (): Promise<void> => {
      try {
        const list = await api.workflow.getAll();
        const mostRecent = [...list].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )[0];
        if (mostRecent) {
          router.replace(`/workflows/${mostRecent.id}`);
        } else {
          setEmpty(true);
        }
      } catch {
        setEmpty(true);
      }
    };

    resolve();
  }, [hasDeepLink, router]);

  if (!empty) {
    return null;
  }

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-3 text-center">
      <h1 className="font-semibold text-xl">No workflows yet</h1>
      <p className="text-muted-foreground text-sm">
        Create your first workflow to get started.
      </p>
      <Button onClick={() => router.push("/")}>New workflow</Button>
    </div>
  );
}
