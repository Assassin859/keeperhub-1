/**
 * Per-action test runner for protocol-coverage (KEEP-458).
 *
 * Iterates registered actions for the (protocol, chain), builds a Manual-
 * trigger workflow on the fly via `buildActionWorkflow`, inserts it, fires
 * via webhook, asserts execution status. Manual only — the webhook-fired
 * execution path ignores the trigger config so the 5 trigger variants give
 * no test signal (those are only useful for dashboard discoverability after
 * seeding).
 */

import { expect, test } from "vitest";
import { getProtocol } from "@/lib/protocol-registry";
import {
  buildActionWorkflow,
  toWebhookTriggered,
} from "@/lib/test-data/build-workflow";
import {
  createApiKey,
  createTestWorkflow,
  getWorkflowWebhookUrl,
  PERSISTENT_TEST_USER_EMAIL,
  waitForWorkflowExecution,
} from "@/tests/utils/db";
import type { SharedCtx } from "./setup";

const TIMEOUT_MS = 120_000;

export function runPhaseFixtures(opts: {
  protocol: string;
  chainId: string;
  phase: "read" | "write";
  ctx: SharedCtx;
}): void {
  const protocol = getProtocol(opts.protocol);
  if (!protocol) {
    test.skip(`protocol ${opts.protocol} not registered`, () => {
      /* no-op */
    });
    return;
  }

  const actions = protocol.actions.filter((a) => a.type === opts.phase);
  if (actions.length === 0) {
    test.skip(`no ${opts.phase} actions on ${opts.protocol}`, () => {
      /* no-op */
    });
    return;
  }

  for (const action of actions) {
    test(
      action.slug,
      async () => {
        const walletAddress = opts.ctx.walletAddress;
        if (!walletAddress) {
          throw new Error(
            "ctx.walletAddress not set; runSetup must have populated it before runPhaseFixtures runs."
          );
        }
        const built = toWebhookTriggered(
          buildActionWorkflow({
            protocolSlug: opts.protocol,
            actionSlug: action.slug,
            chainId: opts.chainId,
            trigger: "Manual",
            walletAddress,
          })
        );

        if (!opts.ctx.apiKey) {
          opts.ctx.apiKey = await createApiKey(PERSISTENT_TEST_USER_EMAIL);
        }
        const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
          name: built.name,
          description: built.description,
          nodes: built.nodes,
          edges: built.edges,
          triggerType: "webhook",
        });
        opts.ctx.workflowIds.push(workflow.id);

        const baseUrl =
          process.env.PROTOCOL_E2E_BASE_URL ?? "http://localhost:3000";
        const url = getWorkflowWebhookUrl(workflow.id, baseUrl);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.ctx.apiKey}`,
          },
          body: JSON.stringify({}),
        });
        expect(response.ok, `webhook returned ${response.status}`).toBe(true);

        const result = await waitForWorkflowExecution(workflow.id, TIMEOUT_MS);
        expect(result, "no execution recorded within timeout").not.toBeNull();
        expect(
          result?.status,
          result?.error ?? "execution did not succeed"
        ).toBe("success");
      },
      TIMEOUT_MS + 30_000
    );
  }
}
