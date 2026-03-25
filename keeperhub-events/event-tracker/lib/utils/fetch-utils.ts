import axios from "axios";
import { KEEPERHUB_API_KEY, KEEPERHUB_API_URL } from "../config/environment";
import type { SyncData } from "../types";
import { logger } from "./logger";

export async function fetchActiveWorkflows(): Promise<SyncData | null> {
  try {
    const { data } = await axios.get<SyncData>(
      `${KEEPERHUB_API_URL}/api/workflows/events?active=true`,
      {
        headers: {
          "X-Internal-Token": KEEPERHUB_API_KEY,
          "X-Service-Key": KEEPERHUB_API_KEY,
        },
      },
    );
    return data;
  } catch (error: any) {
    logger.warn(`Failed to fetch active workflows: ${error.message}`);
    return null;
  }
}
