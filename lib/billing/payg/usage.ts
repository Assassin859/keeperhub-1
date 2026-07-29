import "server-only";

import { getPaygConfig } from "./config-store";
import { getPaygSpentRaw, getPaygUsage } from "./payments";
import { getPaygPeriod, startOfUtcDay } from "./period";

export type PaygCurrentUsage = {
  startedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  periodExecutions: number;
  periodSpentRaw: bigint;
  dailySpentRaw: bigint;
  dailyCapRaw: bigint;
  periodCapRaw: bigint;
  chainId: number;
};

/**
 * Current-period PAYG usage for reporting + guard rails: executions charged and
 * USDC spent this period (window anchored to the enable date), today's spend,
 * and the configured caps. Null if the org has no PAYG config.
 */
export async function getCurrentPaygUsage(
  organizationId: string
): Promise<PaygCurrentUsage | null> {
  const config = await getPaygConfig(organizationId);
  if (!config) {
    return null;
  }
  const period = getPaygPeriod(config.startedAt);
  const [usage, dailySpentRaw] = await Promise.all([
    getPaygUsage(organizationId, period.start, period.end),
    getPaygSpentRaw(organizationId, startOfUtcDay()),
  ]);
  return {
    startedAt: config.startedAt,
    periodStart: period.start,
    periodEnd: period.end,
    periodExecutions: usage.executions,
    periodSpentRaw: usage.spentRaw,
    dailySpentRaw,
    dailyCapRaw: BigInt(config.dailyCapRaw),
    periodCapRaw: BigInt(config.periodCapRaw),
    chainId: config.chainId,
  };
}
