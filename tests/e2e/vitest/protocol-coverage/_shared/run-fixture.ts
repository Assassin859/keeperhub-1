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
import {
  getProtocol,
  type ProtocolAction,
  type ProtocolDefinition,
} from "@/lib/protocol-registry";
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
import type { SharedCtx } from "./setup";

const TIMEOUT_MS = 120_000;

/**
 * Planned per-action outcome for a phase: either a real test that should
 * register, or a documented skip. Pure data -- separated from the vitest
 * registration in `runPhaseFixtures` so the gating logic can be
 * unit-tested without spying on vitest internals.
 *
 *   - `run` carries the action so the caller can build a workflow for it.
 *   - `skip` carries the reason (used in the test name and shown by the
 *     vitest reporter so a green run still surfaces what was skipped).
 *   - `no-protocol` / `no-actions` cover the early-return branches in
 *     `runPhaseFixtures` (unknown protocol slug, no actions for phase).
 */
export type FixtureCase =
  | { kind: "run"; action: ProtocolAction }
  | { kind: "skip"; action: ProtocolAction; reason: string }
  | { kind: "no-protocol"; protocolSlug: string }
  | { kind: "no-actions"; protocolSlug: string; phase: "read" | "write" };

export function planPhaseFixtures(
  protocol: ProtocolDefinition | undefined,
  protocolSlug: string,
  chainId: string,
  phase: "read" | "write"
): FixtureCase[] {
  if (!protocol) {
    return [{ kind: "no-protocol", protocolSlug }];
  }
  const actions = protocol.actions.filter((a) => a.type === phase);
  if (actions.length === 0) {
    return [{ kind: "no-actions", protocolSlug, phase }];
  }
  const skipped = protocol.testData?.[chainId]?.skipped ?? {};
  return actions.map((action) => {
    const reason = skipped[action.slug];
    if (reason) {
      return { kind: "skip", action, reason };
    }
    return { kind: "run", action };
  });
}

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
    opts.phase
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
