/**
 * Pure, testable runner for For Each iteration bodies.
 *
 * Extracted from `executeBodyNode` inside `executor.workflow.ts` so the
 * recursion can be exercised directly in unit tests with a mock step runner,
 * instead of having to spin up the full Vercel Workflow runtime.
 *
 * The contract this enforces matches what the production executor must do
 * inside a single For Each iteration:
 *
 * 1. Skip the node if it is already visited or is the loop's Collect boundary.
 * 2. Run the node's step via the injected `runStep` callback. Persist the
 *    result on `bodyResults` and the step output on `scopedOutputs` (sanitized
 *    nodeId is used as the key, matching the executor's template-resolution
 *    expectations).
 * 3. If the step failed (`result.success === false`), stop the branch.
 * 4. If the actionType is `Condition`, dispatch ONLY to the targets returned
 *    by `resolveBodyConditionTargets` (handle-aware routing).
 * 5. If the actionType is `For Each`, hand off to the caller-provided
 *    `handleNestedForEach`. The nested handler is responsible for running
 *    iterations and continuing past its Collect boundary.
 * 6. For every other (non-Condition, non-For-Each) action with a successful
 *    result, recurse into every target in `bodyEdgesBySource[nodeId]`. THIS
 *    is the contract a regression test confirmed: a successful action with
 *    a downstream edge must dispatch to that edge, regardless of how many
 *    actions or conditions came before it in the iteration body.
 */
import type { EdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { resolveBodyConditionTargets } from "@/lib/workflow/executor/executor.workflow";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import type { WorkflowNode } from "@/lib/workflow/store";

/** Result captured for each step run inside a body iteration. */
export type BodyExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

export type BodyNodeOutputs = Record<
  string,
  { label: string; data: unknown }
>;

/** Metadata about the active iteration; threaded into the step context. */
export type IterationMeta = {
  iterationIndex: number;
  forEachNodeId: string;
};

/** Step runner callback. The runner is responsible for invoking the actual
 *  step (e.g. via the workflow SDK in production, or a vi.fn() in tests). */
export type BodyStepRunner = (params: {
  node: WorkflowNode;
  actionType: string;
  processedConfig: Record<string, unknown>;
  scopedOutputs: BodyNodeOutputs;
  iterationMeta: IterationMeta | undefined;
  stepContext: StepContext;
}) => Promise<unknown>;

/** Hook invoked when the body encounters a nested For Each node. The caller
 *  must run the nested iterations and any post-Collect continuation. */
export type NestedForEachHandler = (params: {
  forEachNodeId: string;
  forEachNode: WorkflowNode;
  processedConfig: Record<string, unknown>;
  scopedOutputs: BodyNodeOutputs;
  bodyResults: Record<string, BodyExecutionResult>;
  bodyVisited: Set<string>;
}) => Promise<void>;

export type RunBodyContext = {
  nodeMap: ReadonlyMap<string, WorkflowNode>;
  bodyEdgesBySource: Map<string, string[]>;
  bodyEdgesBySourceHandle: EdgesBySourceHandle | undefined;
  collectNodeId: string | undefined;
  bodyVisited: Set<string>;
  bodyResults: Record<string, BodyExecutionResult>;
  scopedOutputs: BodyNodeOutputs;
  iterationMeta: IterationMeta | undefined;
  runStep: BodyStepRunner;
  /** Optional hook for nested For Each handling. Called instead of the generic
   *  downstream walk when the visited node is itself a For Each. */
  handleNestedForEach?: NestedForEachHandler;
  /** Process action config (template substitution, dbQuery rewriting, etc.). */
  processConfig: (
    config: Record<string, unknown>,
    actionType: string,
    outputs: BodyNodeOutputs
  ) => Record<string, unknown>;
  /** Resolve a friendly node label for logging / output keys. */
  getNodeName: (node: WorkflowNode) => string;
  /** Async error stringifier (matches executor.workflow.ts getErrorMessageAsync). */
  getErrorMessageAsync: (error: unknown) => Promise<string>;
  /** Inject the workflow's builtin variables into scopedOutputs before each
   *  step runs. The executor uses this to expose `__system.data.unixTimestamp`
   *  and similar variables to template resolution. */
  injectBuiltinVariables: (scopedOutputs: BodyNodeOutputs) => void;
  /** Common StepContext fields (executionId, organizationId, etc.) that don't
   *  vary per node. Per-node fields (nodeId, nodeName, nodeType) are added
   *  inside this function. */
  baseStepContext: Omit<StepContext, "nodeId" | "nodeName" | "nodeType">;
};

const SANITIZE_PATTERN = /[^a-zA-Z0-9]/g;

function sanitizeNodeId(nodeId: string): string {
  return nodeId.replace(SANITIZE_PATTERN, "_");
}

function isErrorStepResult(stepResult: unknown): boolean {
  return (
    typeof stepResult === "object" &&
    stepResult !== null &&
    "success" in stepResult &&
    (stepResult as { success: boolean }).success === false
  );
}

function isDisabled(node: WorkflowNode): boolean {
  return node.data.enabled === false;
}

async function recurseInto(
  targets: readonly string[],
  ctx: RunBodyContext
): Promise<void> {
  for (const next of targets) {
    await runBodyNode(next, ctx);
  }
}

/**
 * Recursively execute a single body node and its downstream targets within a
 * For Each iteration. See module-level docstring for the contract.
 */
export async function runBodyNode(
  nodeId: string,
  ctx: RunBodyContext
): Promise<void> {
  if (ctx.bodyVisited.has(nodeId)) {
    return;
  }
  if (nodeId === ctx.collectNodeId) {
    return;
  }
  ctx.bodyVisited.add(nodeId);

  const node = ctx.nodeMap.get(nodeId);
  if (!node) {
    return;
  }

  if (isDisabled(node)) {
    const sanitizedId = sanitizeNodeId(nodeId);
    ctx.scopedOutputs[sanitizedId] = {
      label: ctx.getNodeName(node),
      data: null,
    };
    const downstream = ctx.bodyEdgesBySource.get(nodeId) ?? [];
    await recurseInto(downstream, ctx);
    return;
  }

  ctx.injectBuiltinVariables(ctx.scopedOutputs);

  try {
    const config = node.data.config ?? {};
    const actionType = config.actionType as string | undefined;

    if (!actionType) {
      ctx.bodyResults[nodeId] = {
        success: false,
        error: `Action node "${node.data.label || node.id}" has no action type configured`,
      };
      return;
    }

    const processedConfig = ctx.processConfig(
      config,
      actionType,
      ctx.scopedOutputs
    );

    const stepContext: StepContext = {
      ...ctx.baseStepContext,
      nodeId: node.id,
      nodeName: ctx.getNodeName(node),
      nodeType: actionType,
      iterationIndex: ctx.iterationMeta?.iterationIndex,
      forEachNodeId: ctx.iterationMeta?.forEachNodeId,
    };

    const stepResult = await ctx.runStep({
      node,
      actionType,
      processedConfig,
      scopedOutputs: ctx.scopedOutputs,
      iterationMeta: ctx.iterationMeta,
      stepContext,
    });

    const result: BodyExecutionResult = isErrorStepResult(stepResult)
      ? {
          success: false,
          error:
            (stepResult as { error?: string }).error ||
            `Step "${actionType}" failed.`,
        }
      : { success: true, data: stepResult };

    ctx.bodyResults[nodeId] = result;
    const sanitizedId = sanitizeNodeId(nodeId);
    ctx.scopedOutputs[sanitizedId] = {
      label: ctx.getNodeName(node),
      data: result.data,
    };

    if (!result.success) {
      return;
    }

    if (actionType === "For Each") {
      if (ctx.handleNestedForEach) {
        await ctx.handleNestedForEach({
          forEachNodeId: nodeId,
          forEachNode: node,
          processedConfig,
          scopedOutputs: ctx.scopedOutputs,
          bodyResults: ctx.bodyResults,
          bodyVisited: ctx.bodyVisited,
        });
      }
      // Fallthrough to generic downstream walk so any node sitting after a
      // nested For Each still executes once the nested handler returns. The
      // nested handler is responsible for marking its own body nodes as
      // visited so we don't re-execute them here.
      const downstream = ctx.bodyEdgesBySource.get(nodeId) ?? [];
      await recurseInto(downstream, ctx);
      return;
    }

    if (actionType === "Condition") {
      const conditionValue = (result.data as { condition?: boolean })?.condition;
      const conditionTargets = resolveBodyConditionTargets(
        conditionValue === true,
        nodeId,
        ctx.bodyEdgesBySourceHandle,
        ctx.bodyEdgesBySource
      );
      await recurseInto(conditionTargets, ctx);
      return;
    }

    // Plain action: dispatch to every downstream target. This is the path
    // that the Autoline Job Keeper regression depended on -- a successful
    // web3/read-contract whose downstream edge points at a code/run-code
    // node MUST recurse into that node, even though there is no condition
    // gating the edge.
    const downstream = ctx.bodyEdgesBySource.get(nodeId) ?? [];
    await recurseInto(downstream, ctx);
  } catch (error) {
    const errorMessage = await ctx.getErrorMessageAsync(error);
    ctx.bodyResults[nodeId] = { success: false, error: errorMessage };
  }
}
