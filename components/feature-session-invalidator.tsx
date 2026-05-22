"use client";

import { useEffect, useRef } from "react";
import { invalidateFeatureSnapshot } from "@/hooks/use-features";
import { useSession } from "@/lib/auth-client";

export function FeatureSessionInvalidator(): null {
  const { data: session } = useSession();
  const lastUserIdRef = useRef<string | null | undefined>(undefined);
  const userId = session?.user?.id ?? null;

  useEffect(() => {
    if (lastUserIdRef.current === undefined) {
      lastUserIdRef.current = userId;
      return;
    }
    if (lastUserIdRef.current !== userId) {
      invalidateFeatureSnapshot();
      lastUserIdRef.current = userId;
    }
  }, [userId]);

  return null;
}
