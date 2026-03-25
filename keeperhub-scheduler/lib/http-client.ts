/**
 * HTTP Client for KeeperHub API
 *
 * Provides authenticated request helper with X-Service-Key header
 */

import { KEEPERHUB_URL, SERVICE_API_KEY } from "./config.js";

/**
 * Make authenticated API request to KeeperHub
 */
export async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${KEEPERHUB_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Service-Key": SERVICE_API_KEY,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${options.method || "GET"} ${path} failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<T>;
}
