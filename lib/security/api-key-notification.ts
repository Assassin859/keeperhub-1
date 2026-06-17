import { sendApiKeyChangeEmail } from "@/lib/email";

/**
 * Out-of-band notification for API key create/revoke. Unlike the new-IP
 * courtesy mail this needs no Redis dedup: a create or revoke is a single
 * deliberate user action, not a per-request fan-out, so each event should send
 * exactly once. Fire-and-forget; the route must never block on SendGrid.
 */

export type ApiKeyChangeNotification = {
  email: string;
  action: "created" | "revoked";
  tokenName: string | null;
  keyPrefix: string;
  when: Date;
};

export function notifyApiKeyChange(
  notification: ApiKeyChangeNotification
): void {
  if (!notification.email) {
    return;
  }
  sendApiKeyChangeEmail(notification).catch(() => {
    // best-effort; sendApiKeyChangeEmail already logs delivery failures
  });
}
