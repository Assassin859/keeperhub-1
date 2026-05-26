// Suppresses signup notifications (Discord webhook, MailerLite subscribe)
// for users who are not actually freshly created. The two call sites that
// fire these notifications live in better-auth hooks that, under some
// flows, can receive a User object for a row that already existed long
// before the hook ran. Treat anything older than the window as a re-event
// rather than a new signup.
//
// 1 hour window: covers the slowest legitimate signup flow (email +
// password with delayed OTP / verification-link click) while keeping
// re-verification of week-old users out of the signup channel.

const NEW_SIGNUP_NOTIFICATION_WINDOW_MS = 60 * 60 * 1000;

export function isFreshSignup(user: {
  createdAt?: Date | string | null;
}): boolean {
  if (!user.createdAt) {
    return false;
  }
  const createdAt =
    user.createdAt instanceof Date ? user.createdAt : new Date(user.createdAt);
  const createdAtMs = createdAt.getTime();
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  return Date.now() - createdAtMs < NEW_SIGNUP_NOTIFICATION_WINDOW_MS;
}
