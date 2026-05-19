import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

export type InfoResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function postInfo<T = unknown>(
  body: Record<string, unknown>,
  actionName: string
): Promise<InfoResult<T>> {
  try {
    const response = await safeFetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      plugin: "hyperliquid",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Hyperliquid] API error:",
        { status: response.status, body: text },
        {
          plugin_name: "hyperliquid",
          action_name: actionName,
          service: "hyperliquid",
        }
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${text || response.statusText}`,
      };
    }

    const data = (await response.json()) as T;
    return { success: true, data };
  } catch (error: unknown) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Hyperliquid] Network error:",
      error,
      {
        plugin_name: "hyperliquid",
        action_name: actionName,
        service: "hyperliquid",
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}
