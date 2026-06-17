import { api } from "@/lib/api-client";
import { buildWorkflow } from "@/lib/scan/factory";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";

type CreateWorkflowResponse = { id: string };

/**
 * Shared persist sequence for scan suggestions.
 *
 * Re-derives the workflow through the factory (re-runs validateTemplateRefs +
 * MaxUint256 + approve-token guards). Cookie confirmInputs are never trusted
 * directly — the factory is the trust boundary (T-54-20).
 *
 * Steps:
 *   1. buildWorkflow(descriptor) — factory re-derivation
 *   2. POST /api/workflows/create  (enabled:true for schedule, false for run)
 *   3. PATCH /api/workflows/{id} with {nodes} — triggers syncWorkflowSchedule
 *      (schedule mode only)
 *   4. api.workflow.execute(id, {}) — immediate one-off run (both modes)
 *
 * Returns { id } so the caller can navigate to /workflows/{id}.
 *
 * Consumed by PendingScanRunner (54-03) and the suggestion drawer (54-04).
 * FUNNEL-03.
 */
export async function persistSuggestion(
  descriptor: SuggestionDescriptor,
  mode: "run" | "schedule"
): Promise<{ id: string }> {
  const { name, description, nodes, edges } = buildWorkflow(descriptor);

  // POST /api/workflows/create
  // enabled:true only for schedule mode; DB default is false (T-54-23 defensive)
  const createRes = await fetch("/api/workflows/create", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description,
      nodes,
      edges,
      enabled: mode === "schedule",
    }),
  });

  if (!createRes.ok) {
    let errBody: { error?: string } = {};
    try {
      errBody = (await createRes.json()) as { error?: string };
    } catch {
      // ignore parse errors
    }
    throw new Error(errBody.error ?? "Failed to create workflow");
  }

  const created = (await createRes.json()) as CreateWorkflowResponse;
  const { id } = created;

  // PATCH triggers syncWorkflowSchedule server-side (schedule mode only)
  if (mode === "schedule") {
    const patchRes = await fetch(`/api/workflows/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes }),
    });

    if (!patchRes.ok) {
      let errBody: { error?: string } = {};
      try {
        errBody = (await patchRes.json()) as { error?: string };
      } catch {
        // ignore parse errors
      }
      throw new Error(errBody.error ?? "Failed to sync schedule");
    }
  }

  // Execute immediately (both run and schedule modes)
  await api.workflow.execute(id, {});

  return { id };
}
