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
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { rateLimitBypassRule, testEndpointsEnabled } from "@/lib/admin-auth";
import { isUserDeactivated } from "@/lib/auth-deactivation-guard";
import { sendInvitationEmail, sendVerificationOTP } from "@/lib/email";
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
  wallet: ["create", "read", "update", "delete"], // ParaWallet
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

// Turnstile is gated on the signup endpoint. In production the secret key
// is required - fail fast at module load rather than serving an open signup
// endpoint. Two skip conditions outside production:
//   1. Vitest / CI unit-test runs (NODE_ENV=test or CI=true) - tests assert
//      config shape without needing a live Turnstile challenge.
//   2. When admin test endpoints are wired up (INCLUDE_TEST_ENDPOINTS=true,
//      with the same runtime gate testEndpointsEnabled enforces). This is
//      the Playwright E2E + local-dev-with-admin-tests path: requests carry
//      X-Test-API-Key for rate-limit bypass, and the captcha plugin's
//      onRequest middleware can't honor that header, so skip the plugin
//      instead. Production never hits this skip because the same gate
//      requires explicit ALLOW_TEST_ENDPOINTS=true and we hard-fail the
//      missing-key assertion below regardless.
const captchaSecretKey = process.env.TURNSTILE_SECRET_KEY;
const captchaSkippedForTests =
  process.env.CI === "true" ||
  process.env.NODE_ENV === "test" ||
  (testEndpointsEnabled() && process.env.NODE_ENV !== "production");

// next build evaluates route modules during the "Collecting page data" phase
// with NODE_ENV=production but no runtime secrets injected. Skip the
// assertion during that phase so the build doesn't crash. The same
// assertion still fires at server boot (phase-production-server) and
// under any custom server that doesn't set NEXT_PHASE.
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build" &&
  !captchaSecretKey
) {
  throw new Error(
    "TURNSTILE_SECRET_KEY is required in production - refusing to expose /sign-up/email without captcha verification"
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
    sendVerificationOnSignUp: true,
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
  if (!(apiKey && user.email)) return;

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
  if (!webhookUrl) return;

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

          // Notify external services for OAuth signups (already verified at creation)
          if (user.emailVerified) {
            await notifyDiscordSignup(user);
            await subscribeToMailerLite(user);
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
        before: async (session) => {
          const userId =
            typeof session.userId === "string" ? session.userId : null;
          if (userId && (await isUserDeactivated(userId))) {
            return false;
          }
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
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  emailVerification: {
    afterEmailVerification: async (user) => {
      console.log("[Auth] afterEmailVerification fired", { email: user.email });
      await notifyDiscordSignup(user);
      await subscribeToMailerLite(user);
    },
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
      enabled: !!process.env.GITHUB_CLIENT_ID,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      enabled: !!process.env.GOOGLE_CLIENT_ID,
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
  },
  trustedOrigins: [...TRUSTED_ORIGINS],
  plugins,
});
