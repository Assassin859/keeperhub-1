// Egress classification for built-in / system actions.
//
// System actions are not plugins, so they carry no `egress` field. This map is
// their source of truth and MUST mirror the keys of SYSTEM_ACTIONS in
// lib/workflow/executor/executor.workflow.ts (the executor's built-in dispatch
// table). The features egress invariant test asserts the two stay in sync, so a
// new system action cannot ship without a classification here.
//
// Pure data, no imports - safe for client, server, and the validator.

import type { EgressTier } from "@/plugins/registry";

export const SYSTEM_ACTION_EGRESS: Record<string, EgressTier> = {
  // The user supplies the connection (host) the runner queries.
  "Database Query": "user-destination",
  // The user supplies the full request URL.
  "HTTP Request": "user-destination",
  // Control-flow actions: no outbound network request.
  Condition: "none",
  "For Each": "none",
  Collect: "none",
};

export function getSystemActionEgress(
  actionType: string
): EgressTier | undefined {
  return SYSTEM_ACTION_EGRESS[actionType];
}
