/**
 * Email utilities for KeeperHub
 * Uses SendGrid API for transactional emails
 */

import { ErrorCategory, logSystemError, logUserError } from "@/lib/logging";

const isTestEnv = !!process.env.CI || process.env.NODE_ENV === "test";

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";

// Cap the outbound SendGrid call so a stalled connection surfaces as a
// failed send (returns false) instead of hanging the request that's
// awaiting it -- otherwise a caller like the verify-IP OTP step spins
// on "Sending..." indefinitely.
const SENDGRID_TIMEOUT_MS = 10_000;

type SendEmailOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/**
 * Normalize email address by removing + suffix
 * e.g., "jacob+test@example.com" -> "jacob@example.com"
 */
function normalizeEmail(email: string): string {
  const [localPart, domain] = email.split("@");
  if (!domain) {
    return email;
  }
  const normalizedLocal = localPart.split("+")[0];
  return `${normalizedLocal}@${domain}`;
}

/**
 * Send an email using SendGrid
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromAddress = process.env.FROM_ADDRESS || "noreply@keeperhub.com";
  const toAddress = normalizeEmail(options.to);

  if (!apiKey) {
    if (isTestEnv) {
      console.warn(
        "[Email] SENDGRID_API_KEY not configured — skipping email send"
      );
    } else {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Email] SENDGRID_API_KEY not configured",
        new Error("SENDGRID_API_KEY environment variable is not configured"),
        {
          component: "email-service",
          service: "sendgrid",
        }
      );
    }
    return false;
  }

  const emailData = {
    personalizations: [
      {
        to: [{ email: toAddress }],
        subject: options.subject,
      },
    ],
    from: { email: fromAddress, name: "KeeperHub" },
    content: [
      {
        type: "text/plain",
        value: options.text,
      },
      ...(options.html
        ? [
            {
              type: "text/html",
              value: options.html,
            },
          ]
        : []),
    ],
  };

  try {
    const response = await fetch(SENDGRID_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailData),
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Email] SendGrid error",
        new Error(errorText),
        {
          service: "sendgrid",
        }
      );
      return false;
    }

    return true;
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Email] Failed to send",
      error,
      {
        service: "sendgrid",
      }
    );
    return false;
  }
}

type InvitationEmailData = {
  inviteeEmail: string;
  inviterName: string;
  organizationName: string;
  role: string;
  inviteLink: string;
};

type VerificationOTPData = {
  email: string;
  otp: string;
  type:
    | "sign-in"
    | "email-verification"
    | "forget-password"
    | "change-email"
    | "confirm-action";
};

/**
 * Send email verification OTP code
 */
export async function sendVerificationOTP(
  data: VerificationOTPData
): Promise<boolean> {
  const { email, otp, type } = data;

  const logoUrl =
    "https://raw.githubusercontent.com/KeeperHub/keeperhub/staging/public/keeperhub_logo_email.png";

  const subjectMap = {
    "sign-in": "Your KeeperHub sign-in code",
    "email-verification": "Verify your email address - KeeperHub",
    "forget-password": "Reset your KeeperHub password",
    "change-email": "Confirm your new email - KeeperHub",
    "confirm-action": "Confirm a sensitive action - KeeperHub",
  };

  const actionTextMap = {
    "sign-in": "sign in",
    "email-verification": "verify your email address",
    "forget-password": "reset your password",
    "change-email": "confirm your new email address",
    "confirm-action": "confirm the action you just requested",
  };

  const actionPromptMap = {
    "sign-in": "Enter this code to sign in:",
    "email-verification": "Enter this code to verify your email address:",
    "forget-password": "Enter this code to reset your password:",
    "change-email": "Enter this code to confirm your new email:",
    "confirm-action": "Enter this code in the app to confirm the action:",
  };

  const subject = subjectMap[type];
  const actionText = actionTextMap[type];
  const actionPrompt = actionPromptMap[type];

  const text = `
Hi there,

Your verification code is: ${otp}

Enter this code to ${actionText}.

This code will expire in 5 minutes.

If you didn't request this code, you can safely ignore this email.

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">Your Verification Code</h2>

    <p>${actionPrompt}</p>

    <div style="text-align: center; margin: 30px 0;">
      <div style="display: inline-block; background: #f5f5f5; padding: 20px 40px; border-radius: 8px; font-size: 32px; font-weight: bold; letter-spacing: 8px; font-family: monospace; color: #1a1a2e;">${otp}</div>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      This code will expire in 5 minutes. If you didn't request this code, you can safely ignore this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
  });

  if (success) {
    console.log(`[Email] OTP sent to ${email} for ${type}`);
  } else if (isTestEnv) {
    console.warn(
      `[Email] Failed to send OTP to ${email} — OTP is stored in DB`
    );
  } else {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send OTP to ${email}`,
      new Error("Failed to send verification OTP"),
      {
        service: "sendgrid",
        email_type: type,
      }
    );
  }

  return success;
}

type OAuthPasswordResetData = {
  email: string;
  providerName: string;
};

/**
 * Send email to OAuth users who try to reset password
 * Informs them to sign in using their OAuth provider instead
 */
export async function sendOAuthPasswordResetEmail(
  data: OAuthPasswordResetData
): Promise<boolean> {
  const { email, providerName } = data;

  const logoUrl =
    "https://raw.githubusercontent.com/KeeperHub/keeperhub/staging/public/keeperhub_logo_email.png";

  const subject = "Password Reset Request - KeeperHub";

  const text = `
Hi there,

We received a password reset request for your KeeperHub account.

Your account is linked to ${providerName} for sign-in. You don't have a password set with KeeperHub - your authentication is managed by ${providerName}.

To sign in, please use the "Continue with ${providerName}" option on our sign-in page.

If you didn't request this, you can safely ignore this email.

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">Password Reset Request</h2>

    <p>We received a password reset request for your KeeperHub account.</p>

    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0; color: #0369a1;">
        <strong>Your account uses ${providerName} for sign-in.</strong><br>
        You don't have a password set with KeeperHub - your authentication is managed by ${providerName}.
      </p>
    </div>

    <p>To sign in, please use the <strong>"Continue with ${providerName}"</strong> option on our sign-in page.</p>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
  });

  if (success) {
    console.log(`[Email] OAuth password reset info sent to ${email}`);
  } else {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send OAuth info to ${email}`,
      new Error("Failed to send OAuth password reset email"),
      {
        service: "sendgrid",
        provider: providerName,
      }
    );
  }

  return success;
}

export async function sendInvitationEmail(
  data: InvitationEmailData
): Promise<boolean> {
  const { inviteeEmail, inviterName, organizationName, role, inviteLink } =
    data;

  const logoUrl =
    "https://raw.githubusercontent.com/KeeperHub/keeperhub/staging/public/keeperhub_logo_email.png";

  const subject = `You've been invited to join ${organizationName} on KeeperHub`;

  const text = `
Hi there,

${inviterName} has invited you to join ${organizationName} organization as a ${role} on KeeperHub.

Click the link below to accept the invitation and create your account:

${inviteLink}

This invitation will expire in 7 days.

If you didn't expect this invitation, you can safely ignore this email.

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">You're Invited!</h2>

    <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong> organization as a <strong>${role}</strong> on KeeperHub.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${inviteLink}" style="display: inline-block; background: #3b82f6; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Accept Invitation</a>
    </div>

    <p style="color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
    <p style="color: #3b82f6; font-size: 14px; word-break: break-all;">${inviteLink}</p>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      This invitation will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: inviteeEmail,
    subject,
    text,
    html,
  });

  if (success) {
    console.log(`[Email] Invitation sent to ${inviteeEmail}`);
  } else if (isTestEnv) {
    console.warn(
      `[Email] Failed to send invitation to ${inviteeEmail} — invitation is stored in DB`
    );
  } else {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send invitation to ${inviteeEmail}`,
      new Error("Failed to send invitation email"),
      {
        service: "sendgrid",
      }
    );
  }

  return success;
}

type NewIpAttemptData = {
  email: string;
  ip: string;
  country: string | null;
  device: string;
  when: Date;
};

/**
 * Notify the account owner that an authenticated request reached them
 * from an IP not in their trust list. The IP gate in the root proxy
 * fires this once per (user, ip) per pod lifetime so a legitimate
 * network change does not flood the inbox.
 */
export async function sendNewIpAttemptEmail(
  data: NewIpAttemptData
): Promise<boolean> {
  const { email, ip, country, device, when } = data;

  const logoUrl =
    "https://raw.githubusercontent.com/KeeperHub/keeperhub/staging/public/keeperhub_logo_email.png";

  const subject = "New sign-in location detected - KeeperHub";

  const whenFormatted = when.toUTCString();
  const countryLabel = country ?? "Unknown";

  const text = `
Hi,

An authenticated request to your KeeperHub account just reached us from a network we have not seen on this account before. If this was you, confirm the new IP by completing the verification step in your browser. If this was not you, change your password and remove the IP from your active sessions immediately.

IP: ${ip}
Country: ${countryLabel}
Device: ${device}
When: ${whenFormatted}

---
KeeperHub - Blockchain Workflow Automation
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <img src="${logoUrl}" alt="KeeperHub" style="max-width: 200px; height: auto;" />
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">New sign-in location detected</h2>

    <p>An authenticated request to your KeeperHub account just reached us from a network we have not seen on this account before.</p>

    <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 20px 0; font-family: monospace; font-size: 14px;">
      <div><strong>IP:</strong> ${ip}</div>
      <div><strong>Country:</strong> ${countryLabel}</div>
      <div><strong>Device:</strong> ${device}</div>
      <div><strong>When:</strong> ${whenFormatted}</div>
    </div>

    <p>If this was you, confirm the new IP by completing the verification step in your browser.</p>

    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0; color: #991b1b;">
        <strong>If this was not you</strong>, change your password and remove the IP from your active sessions immediately.
      </p>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; margin-bottom: 0;">
      You're receiving this because a new network attempted to access your account. To stop these alerts, sign in only from networks you've verified.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">KeeperHub - Blockchain Workflow Automation</p>
  </div>
</body>
</html>
`.trim();

  const success = await sendEmail({
    to: email,
    subject,
    text,
    html,
  });

  if (!(success || isTestEnv)) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Email] Failed to send new-IP notification to ${email}`,
      new Error("Failed to send new-IP notification"),
      {
        service: "sendgrid",
        ip,
      }
    );
  }

  return success;
}
