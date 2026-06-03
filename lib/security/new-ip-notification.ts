import { sendNewIpAttemptEmail } from "@/lib/email";
import { getRedis } from "@/lib/redis";
import { newIpNotifyClaimKey } from "@/lib/redis-keys";
import { describeUserAgentLabel } from "@/lib/security/device-label";
import { logIpVerify } from "@/lib/security/login-risk";

/**
 * Dedup + delivery for the courtesy email the IP gate sends the first time an
 * authenticated request reaches us from a network not in user_trusted_ips.
 * Redis is the sole dedup: `SET NX` is atomic, so even the ~20-request
 * fan-out of a single page load yields exactly one send across the fleet.
 * Fire-and-forget; never blocks the gate.
 */

// Suppress re-sends for a week; the /verify-ip redirect is independent of this.
export const NEW_IP_NOTIFY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * True when this process should send for (userId, ip): the Redis `SET NX`
 * won, so this is the first claim on the network within the TTL. Returns
 * false when another caller already claimed it, when no Redis is configured,
 * or on a Redis error -- with no dedup authority we skip the courtesy email
 * rather than risk one per request. The /verify-ip gate is unaffected either
 * way, so security never depends on this send.
 */
export async function claimNewIpNotification(
  userId: string,
  ip: string
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    return false;
  }
  try {
    const result = await redis.set(
      newIpNotifyClaimKey(userId, ip),
      "1",
      "EX",
      NEW_IP_NOTIFY_TTL_SECONDS,
      "NX"
    );
    return result === "OK";
  } catch (err) {
    logIpVerify("notify-claim-error", {
      userId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}

export type NewIpNotification = {
  userId: string;
  email: string;
  ip: string;
  country: string | null;
  userAgent: string | null;
};

async function deliver(notification: NewIpNotification): Promise<void> {
  const { userId, email, ip, country, userAgent } = notification;
  try {
    if (!(await claimNewIpNotification(userId, ip))) {
      return;
    }
    await sendNewIpAttemptEmail({
      email,
      ip,
      country,
      device: describeUserAgentLabel(userAgent),
      when: new Date(),
    });
  } catch {
    // best-effort; underlying failures are logged in the helpers
  }
}

/**
 * Notify the account owner about a new sign-in network, deduped fleet-wide by
 * the Redis claim in deliver(). Non-blocking; the gate must never wait on
 * Redis or SendGrid.
 */
export function maybeNotifyNewIp(notification: NewIpNotification): void {
  const { userId, ip } = notification;
  if (!(userId && ip)) {
    return;
  }
  deliver(notification).catch(() => {
    // deliver() already swallows; this is the floating-promise boundary
  });
}
