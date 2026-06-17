/**
 * Stub — Wave 0 placeholder for factory validation functions.
 * Full implementation lands in Wave 2 (52-03-PLAN).
 *
 * This file exists so TypeScript resolves the import in the RED test files.
 * All exported functions throw "not implemented" so tests remain RED.
 */
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Assert every {{@nodeId:...}} template ref in node configs resolves to a
 * node present in nodes[].
 * Stub: throws so Wave 0 tests remain RED; replaced in Wave 2.
 */
export function validateTemplateRefs(
  _nodes: WorkflowNode[],
  _edges: WorkflowEdge[]
): ValidationResult {
  throw new Error(
    "validateTemplateRefs: not yet implemented — lands in 52-03-PLAN (Wave 2)"
  );
}

/**
 * Block any approve-token node that uses amount "max" or the numeric MaxUint256
 * string (PREFILL-07).
 * Stub: throws so Wave 0 tests remain RED; replaced in Wave 2.
 */
export function validateNoMaxUint256Approval(
  _nodes: WorkflowNode[]
): ValidationResult {
  throw new Error(
    "validateNoMaxUint256Approval: not yet implemented — lands in 52-03-PLAN (Wave 2)"
  );
}
