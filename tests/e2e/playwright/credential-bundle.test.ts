/**
 * E2E regression test for credential resolution inside Workflow DevKit step bundles.
 *
 * Background: between 2026-03-13 and 2026-04-28 the credential fetcher's
 * fallback (lib/credential-fetcher.ts ca226048) silently returned raw
 * configKey-keyed credentials when the runtime plugin registry was unreachable
 * - which is the case inside step bundles. Plugins where configKey != envVar
 * (Telegram, Slack, SendGrid custom-key) failed at runtime with messages like
 * "Telegram bot token is required" because the step's credentials.<envVar>
 * read returned undefined. The unit tests in tests/unit/credential-fetcher*
 * pin the static map's correctness, but cannot prove the bundler actually
 * ships it. This test exercises the real prod execution path: start a
 * workflow run via POST /api/workflow/{id}/execute, let it run through the
 * step bundle, and assert the failure mode is downstream of the credential
 * gate.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import { expect, test } from "./fixtures";
import {
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
  waitForWorkflowExecution,
} from "./utils/db";

const TELEGRAM_BOT_TOKEN_REQUIRED_RE = /Telegram bot token is required/i;
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_IV_LENGTH = 16;

type CleanupHandle = {
  workflowId: string;
  integrationId: string;
};

function getDb(): ReturnType<typeof postgres> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for this test");
  }
  return postgres(url, { max: 1 });
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Encrypt the integration config the same way lib/db/integrations.ts does.
 * Format: iv:authTag:ciphertext (all hex).
 */
function encryptConfig(config: Record<string, unknown>): string {
  const keyHex = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be a 64-char hex string for this test"
    );
  }
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(ENCRYPTION_IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const plaintext = JSON.stringify(config);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

async function lookupUserAndOrg(
  email: string
): Promise<{ userId: string; organizationId: string }> {
  const sql = getDb();
  try {
    const userRows = await sql`
      SELECT id FROM users WHERE email = ${email}
    `;
    if (userRows.length === 0) {
      throw new Error(`Test user "${email}" not found - seed it first`);
    }
    const userId = userRows[0].id as string;

    const memberRows = await sql`
      SELECT organization_id FROM member WHERE user_id = ${userId} LIMIT 1
    `;
    if (memberRows.length === 0) {
      throw new Error(
        `Test user "${email}" has no organization - sign in once via UI`
      );
    }
    return {
      userId,
      organizationId: memberRows[0].organization_id as string,
    };
  } finally {
    await sql.end();
  }
}

async function createTelegramIntegration(options: {
  userId: string;
  organizationId: string;
  botToken: string;
}): Promise<string> {
  const sql = getDb();
  try {
    const id = generateId();
    const encryptedConfig = encryptConfig({ botToken: options.botToken });
    const now = new Date();
    await sql`
      INSERT INTO integrations (
        id, user_id, organization_id, name, type, config, created_at, updated_at
      ) VALUES (
        ${id},
        ${options.userId},
        ${options.organizationId},
        ${"Telegram (e2e bundle test)"},
        ${"telegram"},
        ${encryptedConfig},
        ${now},
        ${now}
      )
    `;
    return id;
  } finally {
    await sql.end();
  }
}

async function deleteIntegration(integrationId: string): Promise<void> {
  const sql = getDb();
  try {
    await sql`DELETE FROM integrations WHERE id = ${integrationId}`;
  } finally {
    await sql.end();
  }
}

async function createTelegramTestWorkflow(options: {
  userId: string;
  organizationId: string;
  integrationId: string;
}): Promise<string> {
  const sql = getDb();
  try {
    const workflowId = generateId();
    const nodes = [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 200 },
        data: {
          label: "Manual Trigger",
          type: "trigger",
          config: { triggerType: "Manual" },
          status: "idle",
        },
      },
      {
        id: "telegram-1",
        type: "action",
        position: { x: 400, y: 200 },
        data: {
          label: "Send Telegram Message",
          type: "action",
          config: {
            actionType: "telegram/send-message",
            integrationId: options.integrationId,
            chatId: "999999999",
            message: "credential-bundle e2e probe",
            parseMode: "none",
          },
          status: "idle",
        },
      },
    ];
    const edges = [{ id: "e1", source: "trigger-1", target: "telegram-1" }];
    const now = new Date();
    await sql.unsafe(
      `INSERT INTO workflows (
        id, name, description, user_id, organization_id, is_anonymous,
        nodes, edges, visibility, enabled, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, false, $6::jsonb, $7::jsonb, 'private', true, $8, $9
      )`,
      [
        workflowId,
        "Telegram credential bundle e2e probe",
        "Verifies credential plumbing through the Workflow DevKit step bundle.",
        options.userId,
        options.organizationId,
        JSON.stringify(nodes),
        JSON.stringify(edges),
        now,
        now,
      ]
    );
    return workflowId;
  } finally {
    await sql.end();
  }
}

async function safeCleanup(handle: CleanupHandle | null): Promise<void> {
  if (!handle) {
    return;
  }
  await deleteTestWorkflow(handle.workflowId).catch(() => {
    /* best-effort */
  });
  await deleteIntegration(handle.integrationId).catch(() => {
    /* best-effort */
  });
}

test.describe("Credential resolution in workflow step bundles", () => {
  test("Telegram step receives bot token via PLUGIN_CREDENTIAL_MAP, not the lossy fallback", async ({
    page,
  }) => {
    const { userId, organizationId } = await lookupUserAndOrg(
      PERSISTENT_TEST_USER_EMAIL
    );

    // A well-formed but invalid token. Telegram's API will reject with 401,
    // which is exactly what we want: it proves the credential reached the
    // step and the step reached api.telegram.org. Before the fix the step
    // would short-circuit with "Telegram bot token is required" before any
    // outbound HTTP call.
    const botToken = `${randomBytes(4).readUInt32BE(0)}:e2e_invalid_token_${randomBytes(8).toString("hex")}`;
    const integrationId = await createTelegramIntegration({
      userId,
      organizationId,
      botToken,
    });
    const workflowId = await createTelegramTestWorkflow({
      userId,
      organizationId,
      integrationId,
    });
    const cleanup: CleanupHandle = { workflowId, integrationId };

    try {
      const response = await page.request.post(
        `/api/workflow/${workflowId}/execute`,
        { data: {} }
      );
      expect(
        response.ok(),
        `expected 2xx from execute endpoint, got ${response.status()} ${response.statusText()}: ${await response.text()}`
      ).toBeTruthy();

      const result = await waitForWorkflowExecution(workflowId, 90_000);
      expect(result, "workflow execution did not complete in time").not.toBeNull();

      // The execution will fail (bad token) - that's fine. The point is HOW
      // it fails. If the static credential map is wired correctly, the
      // failure is a Telegram API rejection. If the lossy fallback is back,
      // the failure is the local credential-required guard.
      if (result?.error) {
        expect(
          result.error,
          `step failed at the credential gate; static map regression: ${result.error}`
        ).not.toMatch(TELEGRAM_BOT_TOKEN_REQUIRED_RE);
      }
    } finally {
      await safeCleanup(cleanup);
    }
  });
});
