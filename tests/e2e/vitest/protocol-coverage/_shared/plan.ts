/**
 * Pure fixture-planning layer for protocol-coverage.
 *
 * Lives apart from run-fixture.ts because that module imports vitest,
 * which throws when loaded outside a test run - and this logic is also
 * consumed by scripts/protocol-coverage-report.ts (a tsx CLI). The
 * coverage report must agree exactly with what the runner registers, so
 * both import this single implementation.
 */

import type {
  ProtocolAction,
  ProtocolDefinition,
} from "@/lib/protocol-registry";

/**
 * Planned per-action outcome for a phase: either a real test that should
 * register, or a documented skip.
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
