import { KEEPERHUB_API_KEY, KEEPERHUB_API_URL } from "../config/environment";
import type { SyncData } from "../types";
import { logger } from "./logger";

export async function fetchActiveWorkflows(): Promise<SyncData | null> {
  try {
    const response = await fetch(
      `${KEEPERHUB_API_URL}/api/workflows/events?active=true`,
      {
        headers: {
          "X-Internal-Token": KEEPERHUB_API_KEY,
          "X-Service-Key": KEEPERHUB_API_KEY,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as SyncData;
  } catch (error: any) {
    logger.warn(`Failed to fetch active workflows: ${error.message}`);
    return null;
  }
}
