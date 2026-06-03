import { safeFetch } from "@/lib/safe-fetch";
import type { SafeCredentials } from "./credentials";

export async function testSafe(
  credentials: SafeCredentials
): Promise<{ success: boolean; error?: string }> {
  const apiKey = credentials.apiKey;

  if (!apiKey) {
    return { success: false, error: "Safe API key is required" };
  }

  try {
    const response = await safeFetch(
      "https://api.safe.global/tx-service/eth/api/v1/about/",
      {
        plugin: "safe",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!response.ok) {
      return {
        success: false,
        error: `Safe API returned HTTP ${response.status}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to connect to Safe API: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
