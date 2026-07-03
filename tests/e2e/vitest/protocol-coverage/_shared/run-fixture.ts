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
import { checkOutputExpectation, fetchNodeOutput } from "./oracle";
import { planPhaseFixtures } from "./plan";
import type { SharedCtx } from "./setup";

// Planning logic lives in ./plan (vitest-free) so the coverage report CLI
// can share it; re-exported here to keep existing import sites working.
export { type FixtureCase, planPhaseFixtures } from "./plan";

const TIMEOUT_MS = 120_000;

export function runPhaseFixtures(opts: {
  protocol: string;
  chainId: string;
  phase: "read" | "write";
  ctx: SharedCtx;
}): void {
  const protocol = getProtocol(opts.protocol);
  const plan = planPhaseFixtures(
    protocol,
    opts.protocol,
    opts.chainId,
    opts.phase,
    { representatives: process.env.PROTOCOL_E2E_REPRESENTATIVES === "1" }
  );

  for (const c of plan) {
    if (c.kind === "no-protocol") {
      test.skip(`protocol ${c.protocolSlug} not registered`, () => {
        /* no-op */
      });
      continue;
    }
    if (c.kind === "no-actions") {
      test.skip(`no ${c.phase} actions on ${c.protocolSlug}`, () => {
        /* no-op */
      });
      continue;
    }
    if (c.kind === "skip") {
      test.skip(`${c.action.slug} (${c.reason})`, () => {
        /* documented in chainData.skipped */
      });
      continue;
    }
    const action = c.action;
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
        expect(
          result,
          "execution did not reach a terminal status within timeout (either never created or still running)"
        ).not.toBeNull();
        expect(
          result?.status,
          result?.error ?? "execution did not succeed"
        ).toBe("success");

        // Output oracle: when testData declares expectations for this
        // action, assert on the action node's recorded output rather than
        // stopping at execution-level success.
        const expectations =
          protocol?.testData?.[opts.chainId]?.expectations?.[action.slug];
        if (expectations && expectations.length > 0 && result) {
          const actionNode = built.nodes.find((n) => n.id !== "trigger-1");
          if (!actionNode) {
            throw new Error("built workflow has no action node");
          }
          const output = await fetchNodeOutput(
            result.executionId,
            actionNode.id
          );
          for (const expectation of expectations) {
            const failure = checkOutputExpectation(output, expectation);
            expect(failure, failure ?? "").toBeNull();
          }
        }
      },
      TIMEOUT_MS + 30_000
    );
  }
}
