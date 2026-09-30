import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import type { DiscordCredentials } from "../credentials";

type DiscordWebhookResponse = {
  id?: string;
  type?: number;
  channel_id?: string;
  message?: string;
  code?: number;
};

type SendDiscordMessageResult =
  | { success: true; messageId: string }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type SendDiscordMessageCoreInput = {
  discordMessage: string;
  username?: string;
  avatarUrl?: string;
  embedTitle?: string;
  embedColor?: string;
};

export type SendDiscordMessageInput = StepInput &
  SendDiscordMessageCoreInput & {
    integrationId: string;
  };

const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);

const EMBED_COLORS = new Map<string, number>([
  ["red", 15_158_332],
  ["green", 3_066_993],
  ["yellow", 15_844_367],
  ["blue", 3_447_003],
  ["gray", 9_807_270],
]);

const USERNAME_MAX_CHARS = 80;
const EMBED_TITLE_MAX_CHARS = 256;
const EMBED_DESCRIPTION_MAX_CHARS = 4096;

// Discord rejects a webhook username carrying either substring.
const USERNAME_BANNED_SUBSTRINGS = ["discord", "clyde"];

// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are stripped from the username before it reaches the Discord API
const USERNAME_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const LOG_LABELS = {
  plugin_name: "discord",
  action_name: "send-message",
} as const;

type DiscordEmbed = {
  title?: string;
  description: string;
  color?: number;
};

type DiscordWebhookPayload = {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: DiscordEmbed[];
};

/**
 * A malformed avatar URL makes Discord reject the whole request, and this step
 * does not retry, so an unusable value is dropped instead of sent.
 */
function resolveAvatarUrl(
  rawAvatarUrl: string | undefined
): string | undefined {
  const trimmed = rawAvatarUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Discord] Avatar URL is not a valid URL, sending without it",
      undefined,
      LOG_LABELS
    );
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Discord] Avatar URL must use https, sending without it",
      undefined,
      LOG_LABELS
    );
    return undefined;
  }
  return trimmed;
}

/** Same degrade-instead-of-fail treatment for the bot username override. */
function resolveUsername(rawUsername: string | undefined): string | undefined {
  const trimmed = rawUsername?.replace(USERNAME_CONTROL_CHARS, " ").trim();
  if (!trimmed) {
    if (rawUsername?.trim()) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Discord] Bot username has no usable characters, sending without it",
        undefined,
        LOG_LABELS
      );
    }
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  if (USERNAME_BANNED_SUBSTRINGS.some((banned) => lowered.includes(banned))) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Discord] Bot username contains a reserved word, sending without it",
      undefined,
      LOG_LABELS
    );
    return undefined;
  }
  return trimmed.slice(0, USERNAME_MAX_CHARS);
}

/** Returns the Discord colour integer, or undefined when none applies. */
function resolveEmbedColor(
  rawEmbedColor: string | undefined
): number | undefined {
  const key = rawEmbedColor?.trim().toLowerCase();
  if (!key || key === "none") {
    return undefined;
  }
  const color = EMBED_COLORS.get(key);
  if (color === undefined) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Discord] Unrecognised embed colour, sending without it",
      undefined,
      LOG_LABELS
    );
  }
  return color;
}

/**
 * Validates a Discord webhook URL by hostname over https, not by substring.
 * A substring match on "discord.com/api/webhooks/" is satisfied by an
 * off-host URL that carries it in the path (e.g.
 * https://10.0.0.1/discord.com/api/webhooks/x), which points egress at an
 * internal host. The safeFetch SSRF guard is the network-layer backstop;
 * this rejects an off-host URL before any request is attempted.
 */
function isValidDiscordWebhookUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const hostAllowed =
    DISCORD_WEBHOOK_HOSTS.has(host) ||
    host.endsWith(".discord.com") ||
    host.endsWith(".discordapp.com");
  if (!hostAllowed) {
    return false;
  }
  return parsed.pathname.startsWith("/api/webhooks/");
}

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: SendDiscordMessageCoreInput,
  credentials: DiscordCredentials
): Promise<SendDiscordMessageResult> {
  console.log("[Discord] Starting send message step");

  const webhookUrl = credentials.webhookUrl;

  if (!webhookUrl) {
    logUserError(
      ErrorCategory.CONFIGURATION,
      "[Discord] No webhook URL provided in integration",
      undefined,
      {
        plugin_name: "discord",
        action_name: "send-message",
      }
    );
    return {
      success: false,
      error:
        "Discord webhook URL is required. Please configure it in the integration settings.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Validate webhook URL by hostname (not substring) before egress
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Discord] Invalid webhook URL format",
      webhookUrl,
      {
        plugin_name: "discord",
        action_name: "send-message",
      }
    );
    return {
      success: false,
      error: "Invalid Discord webhook URL format",
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    console.log("[Discord] Sending message to webhook");

    const payload: DiscordWebhookPayload = {};

    const username = resolveUsername(input.username);
    if (username) {
      payload.username = username;
    }

    const avatarUrl = resolveAvatarUrl(input.avatarUrl);
    if (avatarUrl) {
      payload.avatar_url = avatarUrl;
    }

    const embedTitle = input.embedTitle?.trim();
    const embedColor = resolveEmbedColor(input.embedColor);

    // An embed carries the message text instead of `content`, so the channel
    // shows it once and the 2000-char content limit does not apply.
    if (embedTitle || embedColor !== undefined) {
      payload.embeds = [
        {
          ...(embedTitle
            ? { title: embedTitle.slice(0, EMBED_TITLE_MAX_CHARS) }
            : {}),
          description: input.discordMessage.slice(
            0,
            EMBED_DESCRIPTION_MAX_CHARS
          ),
          ...(embedColor !== undefined ? { color: embedColor } : {}),
        },
      ];
    } else {
      payload.content = input.discordMessage;
    }

    const response = await safeFetch(webhookUrl, {
      plugin: "discord",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({}))) as DiscordWebhookResponse;
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Discord] API error:",
        errorData,
        {
          plugin_name: "discord",
          action_name: "send-message",
          service: "discord",
        }
      );
      return {
        success: false,
        error:
          errorData.message ||
          `HTTP ${response.status}: Failed to send Discord message`,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    // Discord webhooks return 204 No Content on success or the message object
    const result =
      response.status === 204
        ? null
        : ((await response.json().catch(() => ({}))) as DiscordWebhookResponse);

    console.log("[Discord] Message sent successfully");

    return {
      success: true,
      messageId: result?.id || "sent",
    };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Discord] Error sending message:",
      error,
      {
        plugin_name: "discord",
        action_name: "send-message",
        service: "discord",
      }
    );
    return {
      success: false,
      error: `Failed to send Discord message: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendDiscordMessageStep(
  input: SendDiscordMessageInput
): Promise<SendDiscordMessageResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null });

  return runPluginStep(
    { pluginName: "discord", actionName: "send-message" },
    input,
    () => stepHandler(input, credentials)
  );
}
sendDiscordMessageStep.maxRetries = 0;

export const _integrationType = "discord";
