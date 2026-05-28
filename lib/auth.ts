import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  anonymous,
  // start custom keeperhub code //
  bearer,
  // end keeperhub code //
  captcha,
  deviceAuthorization,
  emailOTP,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { rateLimitBypassRule, testEndpointsEnabled } from "@/lib/admin-auth";
import { isUserDeactivated } from "@/lib/auth-deactivation-guard";
import { isFreshSignup } from "@/lib/auth-notification-guard";
import { sendInvitationEmail, sendVerificationOTP } from "@/lib/email";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  assessIpTrust,
  assessLoginRisk,
  serializeRiskFlags,
} from "@/lib/security/login-risk";
import { TRUSTED_ORIGINS } from "@/lib/trusted-origins";
import { wrapWithSessionTokenHash } from "./auth-session-token-hash";
import { db } from "./db";
import {
  accounts,
  deviceCode,
  integrations,
  invitationRelations,
  invitation as invitationTable,
  memberRelations,
  member as memberTable,
  organizationRelations,
  organizationSubscriptions,
  organization as organizationTable,
  sessions,
  twoFactor as twoFactorTable,
  userTrustedIps,
  users,
  verifications,
  workflowExecutionLogs,
  workflowExecutions,
  workflowExecutionsRelations,
  workflows,
} from "./db/schema";

// Define custom access control for organization resources
const statement = {
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["read", "update", "delete"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "cancel"],
} as const;

const ac = createAccessControl(statement);

// Define role permissions aligned with requirements
const memberRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["read"],
  wallet: ["read"], // Can use wallet, not manage
  organization: ["read"],
  member: ["read"],
});

const adminRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"], // Can manage wallets
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

const ownerRole = ac.newRole({
  workflow: ["create", "read", "update", "delete"],
  credential: ["create", "read", "update", "delete"],
  wallet: ["create", "read", "update", "delete"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

// Construct schema object for drizzle adapter
const schema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  twoFactor: twoFactorTable,
  deviceCode,
  workflows,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionsRelations,
  organization: organizationTable,
  member: memberTable,
  invitation: invitationTable,
  organizationRelations,
  memberRelations,
  invitationRelations,
};

function getBaseURL() {
  if (process.env.BETTER_AUTH_URL) {
    return process.env.BETTER_AUTH_URL;
  }
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }
  return "http://localhost:3000";
}

// Turnstile is gated on the signup endpoint. The secret key is required
// wherever the plugin is enforced - fail fast at module load rather than
// serving an open signup endpoint. Skip conditions:
//   1. Vitest / CI unit-test runs (NODE_ENV=test or CI=true) - tests assert
//      config shape without needing a live Turnstile challenge. These win
//      over TURNSTILE_ENFORCE so unit runs never load the live plugin.
//   2. When admin test endpoints are wired up (INCLUDE_TEST_ENDPOINTS=true,
//      with the same runtime gate testEndpointsEnabled enforces) and the
//      environment has NOT opted in via TURNSTILE_ENFORCE. This is the
//      Playwright E2E + local-dev-with-admin-tests path: requests carry
//      X-Test-API-Key for rate-limit bypass, and the captcha plugin's
//      onRequest middleware can't honor that header, so skip the plugin
//      instead.
// TURNSTILE_ENFORCE=true opts a non-production environment (staging,
// pr-deploy) into loading the plugin so the real Turnstile flow can be
// exercised before prod. Note: with the plugin loaded, the X-Test-API-Key
// signup bypass no longer applies - that environment's site/secret keys must
// be ones the widget+server can pass (e.g. Cloudflare's always-pass test
// keys) for any UI-driven signup E2E to keep working.
const captchaSecretKey = process.env.TURNSTILE_SECRET_KEY;
const captchaForceEnabled = process.env.TURNSTILE_ENFORCE === "true";
const captchaSkippedForTests =
  process.env.CI === "true" ||
  process.env.NODE_ENV === "test" ||
  (!captchaForceEnabled &&
    testEndpointsEnabled() &&
    process.env.NODE_ENV !== "production");

// Captcha is mandatory in production and in any environment that explicitly
// opts in via TURNSTILE_ENFORCE. next build evaluates route modules during
// the "Collecting page data" phase with NODE_ENV=production but no runtime
// secrets injected, so skip the assertion during that phase to avoid crashing
// the build. The assertion still fires at server boot (phase-production-server)
// and under any custom server that doesn't set NEXT_PHASE.
const captchaRequired =
  (process.env.NODE_ENV === "production" || captchaForceEnabled) &&
  process.env.NEXT_PHASE !== "phase-production-build";
if (captchaRequired && !captchaSecretKey) {
  throw new Error(
    "TURNSTILE_SECRET_KEY is required in production (or when TURNSTILE_ENFORCE=true) - refusing to expose /sign-up/email without captcha verification"
  );
}

const captchaPlugins =
  !captchaSkippedForTests && captchaSecretKey
    ? [
        captcha({
          provider: "cloudflare-turnstile",
          secretKey: captchaSecretKey,
          endpoints: ["/sign-up/email"],
        }),
      ]
    : [];

// Build plugins array conditionally
const plugins = [
  // start custom keeperhub code //
  bearer(),
  deviceAuthorization({
    expiresIn: "15m",
    interval: "5s",
  }),
  // TOTP only. Email-OTP-as-second-factor is intentionally left without a
  // sendOTP callback because email OTP is already our primary login factor;
  // using it as the "second" factor would collapse both factors onto the
  // same channel. The /two-factor/send-otp endpoint is therefore inert
  // (would fail at call time) but our UI never invokes it. Backup codes
  // provide the recovery path. Enrollment is handled by a custom
  // passwordless endpoint (see app/api/user/totp/setup) because the
  // plugin's /two-factor/enable requires a password and most of our users
  // sign in via OAuth or email OTP.
  twoFactor({
    issuer: "KeeperHub",
    // Mandatory-MFA mode: do not remember the device. The plugin's
    // default `trustDeviceMaxAge` is 30 days, which lets a user skip
    // the TOTP step on the same browser for that window. Setting it
    // to 0 forces a TOTP prompt on every login, matching the
    // proxy-level requires_mfa=true-on-every-session policy.
    trustDeviceMaxAge: 0,
    // The plugin exposes an inert email-OTP-as-second-factor path
    // (no sendOTP wired, see comment above). If we ever turn it on,
    // store the OTP encrypted rather than the plugin default of
    // plaintext. Same primitive that the emailOTP plugin uses for
    // its own OTPs (KEEP-625). Defense in depth; sets the right
    // default ahead of any future flip.
    otpOptions: {
      storeOTP: "encrypted",
    },
  }),
  // end keeperhub code //
  emailOTP({
    async sendVerificationOTP({ email, otp, type }) {
      console.log(`[Auth] Sending OTP to ${email} for ${type}`);
      const success = await sendVerificationOTP({
        email,
        otp,
        type,
      });
      if (!success) {
        const msg = `[Auth] Failed to send verification email to ${email} — OTP is stored in DB`;
        if (process.env.CI || process.env.NODE_ENV === "test") {
          console.warn(msg);
        } else {
          console.error(msg);
        }
      }
    },
    otpLength: 6,
    expiresIn: 300, // 5 minutes
    // OTP delivery for credential signups is driven from
    // databaseHooks.user.create.after, which fires only when a new
    // user row is actually written. The plugin's
    // sendVerificationOnSignUp hook would otherwise fire on Better
    // Auth's synthetic-success response (returned anti-enumeration
    // when the email already belongs to an account), which would
    // dispatch an OTP to that inbox even though no DB write
    // happened.
    sendVerificationOnSignUp: false,
    // KEEP-625: the better-auth emailOTP plugin defaults to storing
    // OTPs in plaintext in the verifications table. With "encrypted"
    // the value is symmetric-encrypted with BETTER_AUTH_SECRET via
    // the same symmetricEncrypt used elsewhere, so a DB-read alone
    // can't reveal a live 6-digit code — the attacker also needs
    // the server secret. "hashed" would be cryptographically
    // brute-forceable in seconds for a 6-digit space; "encrypted"
    // is the right primitive for short, low-entropy secrets.
    storeOTP: "encrypted",
  }),
  anonymous({
    async onLinkAccount(data) {
      // // When an anonymous user links to a real account, migrate their data
      // const fromUserId = data.anonymousUser.user.id;
      // const toUserId = data.newUser.user.id;

      // console.log(
      //   `[Anonymous Migration] Migrating from user ${fromUserId} to ${toUserId}`
      // );

      // try {
      //   // Migrate workflows
      //   await db
      //     .update(workflows)
      //     .set({ userId: toUserId })
      //     .where(eq(workflows.userId, fromUserId));

      //   // Migrate workflow executions
      //   await db
      //     .update(workflowExecutions)
      //     .set({ userId: toUserId })
      //     .where(eq(workflowExecutions.userId, fromUserId));

      //   // Migrate integrations
      //   await db
      //     .update(integrations)
      //     .set({ userId: toUserId })
      //     .where(eq(integrations.userId, fromUserId));

      //   console.log(
      //     `[Anonymous Migration] Successfully migrated data from ${fromUserId} to ${toUserId}`
      //   );
      // } catch (error) {
      //   console.error(
      //     "[Anonymous Migration] Error migrating user data:",
      //     error
      //   );
      //   throw error;
      // }

      // When anonymous user links account, transfer ownership to the new user.
      // Workflows stay as isAnonymous=true with no org - the client-side claim
      // dialog will offer to move them into the user's organization.
      const fromUserId = data.anonymousUser.user.id;
      const toUserId = data.newUser.user.id;

      try {
        await db
          .update(workflows)
          .set({ userId: toUserId })
          .where(eq(workflows.userId, fromUserId));

        await db
          .update(workflowExecutions)
          .set({ userId: toUserId })
          .where(eq(workflowExecutions.userId, fromUserId));

        await db
          .update(integrations)
          .set({ userId: toUserId })
          .where(eq(integrations.userId, fromUserId));
      } catch (error) {
        console.error("[Anonymous Migration] Error:", error);
        throw error;
      }
    },
  }),
  ...captchaPlugins,
  organization({
    // Access control with custom roles
    ac,
    roles: {
      owner: ownerRole,
      admin: adminRole,
      member: memberRole,
    },

    // Email invitation handler using SendGrid
    async sendInvitationEmail(data) {
      const inviteLink = `${getBaseURL()}/accept-invite/${data.id}`;

      console.log(`[Invitation] Sending to ${data.email}`, {
        inviter: data.inviter.user.name,
        organization: data.organization.name,
        role: data.role,
        link: inviteLink,
      });

      try {
        await sendInvitationEmail({
          inviteeEmail: data.email,
          inviterName: data.inviter.user.name || "A team member",
          organizationName: data.organization.name,
          role: data.role || "member",
          inviteLink,
        });
      } catch (error) {
        console.warn(
          `[Invitation] Email delivery failed for ${data.email}, invitation is still valid`,
          error
        );
      }
    },

    // Invitation settings
    invitationExpiresIn: 7 * 24 * 60 * 60, // 7 days
    cancelPendingInvitationsOnReInvite: true,

    // Hooks for custom business logic
    organizationHooks: {
      async afterCreateOrganization(data) {
        const { organization: org } = data;
        await db
          .insert(organizationSubscriptions)
          .values({
            organizationId: org.id,
            plan: "free",
            status: "active",
          })
          .onConflictDoNothing({
            target: organizationSubscriptions.organizationId,
          });
      },

      async afterAddMember() {
        await Promise.resolve();
      },

      async afterAcceptInvitation() {
        await Promise.resolve();
      },
    },
  }),
];

async function subscribeToMailerLite(user: {
  name?: string | null;
  email?: string | null;
}): Promise<void> {
  const apiKey = process.env.MAILERLITE_API_KEY;
  if (!(apiKey && user.email)) {
    return;
  }

  await fetch("https://connect.mailerlite.com/api/subscribers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: user.email,
      groups: ["184355071771804948", "184358071395419781"],
      status: "active",
    }),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(
          `[MailerLite] Subscribe failed: ${res.status} ${res.statusText}`
        );
      }
    })
    .catch((err: unknown) => {
      console.error("[MailerLite] Subscribe request error:", err);
    });
}

async function notifyDiscordSignup(user: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_SIGNUPS;
  if (!webhookUrl) {
    return;
  }

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "KeeperHub",
      embeds: [
        {
          title: "New signup",
          color: 5_763_719,
          fields: [
            { name: "Name", value: user.name ?? "N/A", inline: true },
            { name: "Email", value: user.email ?? "N/A", inline: true },
            {
              name: "Method",
              value: user.image ? "OAuth" : "Email",
              inline: true,
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(
          `[Discord] Webhook failed: ${res.status} ${res.statusText}`
        );
      }
    })
    .catch((err: unknown) => {
      console.error("[Discord] Webhook request error:", err);
    });
}

export const auth = betterAuth({
  baseURL: getBaseURL(),
  database: wrapWithSessionTokenHash(
    drizzleAdapter(db, {
      provider: "pg",
      schema,
    })
  ),
  logger: {
    level: "debug",
    disabled: false,
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Skip organization creation for anonymous users
          // Anonymous users have name "Anonymous" and temp- prefixed emails
          const isAnonymous =
            user.name === "Anonymous" || user.email?.startsWith("temp-");
          if (isAnonymous) {
            return;
          }

          // Generate unique slug from user name/email
          const baseName = user.name || user.email?.split("@")[0] || "User";
          const slug = `${baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${nanoid(6)}`;

          try {
            const orgId = randomUUID();
            const memberId = randomUUID();

            // Create organization directly in database (we don't have auth context here)
            const [org] = await db
              .insert(organizationTable)
              .values({
                id: orgId,
                name: `${baseName}'s Organization`,
                slug,
                createdAt: new Date(),
              })
              .returning();

            // Add user as owner member
            await db.insert(memberTable).values({
              id: memberId,
              organizationId: org.id,
              userId: user.id,
              role: "owner",
              createdAt: new Date(),
            });
          } catch (error) {
            console.error(error);
          }

          // Notify external services for OAuth signups (already verified at creation).
          // `databaseHooks.user.create.after` only fires on actual user-row
          // inserts in current better-auth, so the freshness guard here is
          // belt-and-suspenders against any future adapter or hook reroute
          // that delivers an already-existing user into this path. Real
          // OAuth signups have createdAt = now and pass it trivially.
          if (user.emailVerified && isFreshSignup(user)) {
            await notifyDiscordSignup(user);
            await subscribeToMailerLite(user);
          }

          // Credential signup: dispatch the verification OTP here
          // rather than via emailOTP.sendVerificationOnSignUp. This
          // hook only runs on a real user-row insert, so the OTP
          // can never reach the inbox of a pre-existing account
          // when an attacker POSTs /sign-up/email with that email.
          // OAuth users come pre-verified (provider attested), so
          // skip them. The `!user.emailVerified` guard separates
          // the two paths cleanly.
          if (!user.emailVerified && user.email) {
            try {
              await auth.api.sendVerificationOTP({
                body: { email: user.email, type: "email-verification" },
                headers: new Headers(),
              });
            } catch (error) {
              console.error(
                "[Auth] Failed to dispatch signup verification OTP",
                { email: user.email, userId: user.id },
                error
              );
            }
          }
        },
      },
    },
    session: {
      create: {
        // Reject session creation when the user has been deactivated.
        // Better Auth's OAuth callback otherwise mints a fresh session on
        // every Google/GitHub signin attempt because it has no awareness
        // of users.deactivated_at. Returning false aborts the write before
        // the sessions row exists, so no cookie ever ships to the client.
        //
        // Mandatory step-up on every TOTP-enrolled login: every new
        // session for a user with two_factor_enabled = true starts with
        // requires_mfa = true. The per-action guards in
        // lib/middleware/owner-mfa-guard.ts then refuse sensitive actions
        // until the user completes /verify-mfa, which clears the flag.
        // Previously the flag was only set when login-risk detection
        // flagged a country anomaly; flipping it on unconditionally makes
        // step-up uniform across every fresh login rather than only the
        // risk-flagged subset. The geo risk signal is still recorded in
        // sessions.risk_flags_json when present, for detection / alerting.
        //
        // Forced enrollment for users without TOTP is intentionally not
        // wired here: a session for a non-TOTP user gets requires_mfa =
        // false because there is nothing to step up to. Mandating the
        // enrollment wizard is a separate follow-up.
        before: async (session) => {
          const userId =
            typeof session.userId === "string" ? session.userId : null;
          if (!userId) {
            return;
          }
          if (await isUserDeactivated(userId)) {
            return false;
          }
          const risk = await assessLoginRisk(userId);
          const ipTrust = await assessIpTrust(userId);
          // When the session is being created from a trusted IP (or
          // for the user's first-ever attestation) record/refresh it
          // in user_trusted_ips. This is the only path that auto-adds
          // an IP without going through /verify-ip; the unique
          // (user_id, ip) constraint makes the upsert idempotent so a
          // repeat sign-in from a known IP just bumps last_seen_at.
          if (ipTrust.ip && ipTrust.trusted) {
            try {
              await db
                .insert(userTrustedIps)
                .values({
                  userId,
                  ip: ipTrust.ip,
                  country: ipTrust.country,
                })
                .onConflictDoUpdate({
                  target: [userTrustedIps.userId, userTrustedIps.ip],
                  set: { lastSeenAt: new Date() },
                });
            } catch (err) {
              // Trust list bookkeeping must never block sign-in. If
              // the insert fails the next sign-in from the same IP
              // will hit the /verify-ip gate, which is the correct
              // fail-closed direction.
              logSystemError(
                ErrorCategory.DATABASE,
                "[ip-trust] failed to upsert trusted IP",
                err,
                { user_id: userId, ip: ipTrust.ip }
              );
            }
          }
          const [userRow] = await db
            .select({ twoFactorEnabled: users.twoFactorEnabled })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          const twoFactorEnabled = userRow?.twoFactorEnabled === true;
          // Sessions that still need step-up get a short TTL so a stolen
          // cookie expires before a legitimate user finishes the
          // /verify-mfa flow.
          const PRE_STEPUP_TTL_MS = 10 * 60 * 1000;
          // IP-verification does not write to the session row. The
          // atomic flow in strict-signin / oauth-mfa-finalize / the
          // /verify-ip endpoint resolves IP trust BEFORE any session
          // is minted: an untrusted IP produces a signed
          // `pending_ip_verify` cookie and no session, and a trusted
          // IP mints the session as-is.
          return {
            data: twoFactorEnabled
              ? {
                  requiresMfa: true,
                  expiresAt: new Date(Date.now() + PRE_STEPUP_TTL_MS),
                  riskFlagsJson: risk.country ? serializeRiskFlags(risk) : null,
                }
              : {
                  requiresMfa: false,
                  riskFlagsJson: risk.country ? serializeRiskFlags(risk) : null,
                },
          };
        },
        after: async (session) => {
          // If session already has an active organization, skip
          if (session.activeOrganizationId) {
            return;
          }

          try {
            // Find the user's first organization
            const [member] = await db
              .select()
              .from(memberTable)
              .where(eq(memberTable.userId, session.userId))
              .limit(1);

            if (member) {
              // Set as active organization in the session
              await db
                .update(sessions)
                .set({ activeOrganizationId: member.organizationId })
                .where(eq(sessions.id, session.id));
            }
          } catch (error) {
            console.error(error);
          }
        },
      },
    },
    account: {
      create: {
        // Defence in depth for the OAuth re-link path: even if the session
        // hook above ever regresses, refuse to attach a fresh GitHub/Google
        // accounts row to a deactivated users row. Otherwise the attacker
        // shape is: OAuth callback misses the wiped accounts row, falls
        // back to email match, links a new accounts row, then proceeds to
        // session creation.
        before: async (account) => {
          const userId =
            typeof account.userId === "string" ? account.userId : null;
          if (userId && (await isUserDeactivated(userId))) {
            return false;
          }
        },
      },
    },
  },
  onAPIError: {
    onError: (error, ctx) => {
      console.error("[Better Auth API Error]", {
        error:
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
              }
            : error,
        context: ctx,
      });
    },
  },
  // Declare the custom session columns we added in migration 0089
  // (`requires_mfa`, `mfa_verified_at`, `risk_flags_json`). Without
  // these declarations Better Auth filters them out of any insert/
  // update payload before reaching the Drizzle adapter, so the
  // session.create.before hook's `data: { requiresMfa: true }` is
  // silently dropped and every TOTP-enrolled user sails past the
  // step-up gate. This is the field-declaration backbone for the
  // mandatory-step-up policy in proxy.ts.
  session: {
    additionalFields: {
      requiresMfa: { type: "boolean", defaultValue: false },
      mfaVerifiedAt: { type: "date", required: false },
      riskFlagsJson: { type: "string", required: false },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  emailVerification: {
    afterEmailVerification: async (user) => {
      // Only fire signup-channel notifications on first-time verification of a
      // freshly-created user. Re-verification flows (and any provider that
      // re-asserts emailVerified for an existing user) must not page the
      // signup channel.
      if (!isFreshSignup(user)) {
        return;
      }
      await notifyDiscordSignup(user);
      await subscribeToMailerLite(user);
    },
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
      enabled: !!process.env.GITHUB_CLIENT_ID,
      // Force the provider to re-prompt at every sign-in rather than
      // silently reusing an existing IdP session. Combined with the
      // session.create.before hook setting requires_mfa=true on every
      // TOTP-enrolled session, this gives the closest practical match
      // to "MFA on every login" for the OAuth path. The IdP itself
      // still owns the second-factor step on its side.
      prompt: "login",
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      enabled: !!process.env.GOOGLE_CLIENT_ID,
      prompt: "login",
    },
  },
  rateLimit: {
    enabled: !(process.env.CI || process.env.NODE_ENV === "test"),
    customRules: {
      // Per-IP signup gate (5/hour). Declared before "/*" so first-match
      // wins on /sign-up/email. The bypass is still honored via the
      // explicit call below so Playwright E2E keeps working with the
      // X-Test-API-Key header. In-memory storage means the effective
      // limit is 5 * pod_count; acceptable as defense-in-depth behind
      // Turnstile until a shared store is wired up.
      "/sign-up/email": (req) =>
        rateLimitBypassRule(req, { window: 3600, max: 5 }),
      // Rate-limit bypass is gated by the same predicate as admin test
      // routes (build-time + runtime). See lib/admin-auth.ts for the gate
      // and KEEP-237 for context.
      "/*": rateLimitBypassRule,
    },
  },
  advanced: {
    // Use secure cookies in production (HTTPS only)
    useSecureCookies: process.env.NODE_ENV === "production",
    // Resolve the client IP from CF-Connecting-IP, not the default
    // X-Forwarded-For. better-auth's getIp takes the leftmost XFF value;
    // Cloudflare appends the real client IP to any client-supplied XFF rather
    // than stripping it, so the leftmost value is attacker-controlled and the
    // /sign-up/email rate limit above would be trivially bypassable via XFF
    // spoofing. CF-Connecting-IP is set by Cloudflare's edge and cannot be
    // forged by the client. All envs sit behind Cloudflare with origin-pull,
    // so this header is always present. Swap if the edge ever changes (e.g.
    // X-Real-IP for nginx).
    ipAddress: {
      ipAddressHeaders: ["CF-Connecting-IP"],
    },
  },
  trustedOrigins: [...TRUSTED_ORIGINS],
  plugins,
});
