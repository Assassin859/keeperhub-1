export type WorkflowValidationIssue = {
  code: string;
  message: string;
  parameterPath: string;
  nodeId?: string;
  fieldKey?: string;
};

export type WorkflowValidationResult = {
  valid: boolean;
  nodeCount: number;
  errors?: WorkflowValidationIssue[];
  warnings?: WorkflowValidationIssue[];
};

export type WorkflowSimulationResult = {
  simulatedNodeCount: number;
  skippedNodeCount: number;
  errors?: WorkflowValidationIssue[];
  warnings?: WorkflowValidationIssue[];
};

export type WorkflowValidationNode = {
  id?: unknown;
};

export type WorkflowValidationOverlayIssues = {
  validationErrors: WorkflowValidationIssue[];
  validationWarnings: WorkflowValidationIssue[];
  onRunAnyway?: () => void | Promise<void>;
};

type WorkflowValidationFetcher = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

type RunWorkflowValidationPreflightParams = {
  workflowId: string;
  nodes: WorkflowValidationNode[];
  fetcher?: WorkflowValidationFetcher;
  onOpenIssues: (issues: WorkflowValidationOverlayIssues) => void;
  onStartWorkflowExecution: () => void | Promise<void>;
  onError: (message: string) => void;
};

const NODE_PARAMETER_PATH =
  /^nodes\[(\d+)\](?:\.data)?(?:\.config(?:\.([^.[\]]+))?)?/;

/**
 * Adds editor navigation targets to server issues when their parameter paths
 * identify a specific workflow node.
 */
export function mapWorkflowValidationIssues(
  issues: WorkflowValidationIssue[] | undefined,
  nodes: WorkflowValidationNode[]
): WorkflowValidationIssue[] {
  if (!issues) {
    return [];
  }

  return issues.map((issue) => {
    const match = NODE_PARAMETER_PATH.exec(issue.parameterPath);
    if (!match) {
      return issue;
    }

    const nodeIndex = Number(match[1]);
    const node = nodes[nodeIndex];

    if (!node || typeof node.id !== "string") {
      return issue;
    }

    return {
      ...issue,
      nodeId: node.id,
      fieldKey: match[2],
    };
  });
}

async function fetchValidationResult(
  workflowId: string,
  fetcher: WorkflowValidationFetcher,
  onError: (message: string) => void
): Promise<WorkflowValidationResult | null> {
  let response: Response;

  try {
    response = await fetcher(`/api/workflows/${workflowId}/validate`);
  } catch {
    onError("Could not validate the workflow before running it");
    return null;
  }

  if (!response.ok) {
    onError("Could not validate the workflow before running it");
    return null;
  }

  const payload = (await response.json().catch(() => null)) as {
    result?: WorkflowValidationResult;
  } | null;

  if (!payload?.result) {
    onError("Workflow validation returned an unexpected response");
    return null;
  }

  return payload.result;
}

async function fetchSimulationResult(
  workflowId: string,
  fetcher: WorkflowValidationFetcher,
  onError: (message: string) => void
): Promise<WorkflowSimulationResult | null> {
  let response: Response;

  try {
    response = await fetcher(`/api/workflows/${workflowId}/simulate`, {
      method: "POST",
    });
  } catch {
    onError("Could not simulate workflow writes before running it");
    return null;
  }

  if (!response.ok) {
    onError("Could not simulate workflow writes before running it");
    return null;
  }

  const payload = (await response.json().catch(() => null)) as {
    result?: WorkflowSimulationResult;
  } | null;

  if (!payload?.result) {
    onError("Workflow simulation returned an unexpected response");
    return null;
  }

  return payload.result;
}

/**
 * Runs structural validation followed by read-only EVM write simulation.
 *
 * Confirmed validation or simulation failures block execution. Warnings can be
 * overridden through Run Anyway.
 */
export async function runWorkflowValidationPreflight({
  workflowId,
  nodes,
  fetcher = fetch,
  onOpenIssues,
  onStartWorkflowExecution,
  onError,
}: RunWorkflowValidationPreflightParams): Promise<void> {
  const validation = await fetchValidationResult(workflowId, fetcher, onError);

  if (!validation) {
    return;
  }

  const validationErrors = mapWorkflowValidationIssues(
    validation.errors,
    nodes
  );
  const validationWarnings = mapWorkflowValidationIssues(
    validation.warnings,
    nodes
  );

  // Avoid RPC work when structural validation already proves that the saved
  // workflow cannot run.
  if (validationErrors.length > 0) {
    onOpenIssues({
      validationErrors,
      validationWarnings,
      onRunAnyway: undefined,
    });
    return;
  }

  const simulation = await fetchSimulationResult(workflowId, fetcher, onError);

  if (!simulation) {
    return;
  }

  const simulationErrors = mapWorkflowValidationIssues(
    simulation.errors,
    nodes
  );
  const simulationWarnings = mapWorkflowValidationIssues(
    simulation.warnings,
    nodes
  );

  const combinedErrors = [...validationErrors, ...simulationErrors];
  const combinedWarnings = [...validationWarnings, ...simulationWarnings];

  if (combinedErrors.length > 0 || combinedWarnings.length > 0) {
    onOpenIssues({
      validationErrors: combinedErrors,
      validationWarnings: combinedWarnings,
      onRunAnyway:
        combinedErrors.length === 0 ? onStartWorkflowExecution : undefined,
    });
    return;
  }

  await onStartWorkflowExecution();
}
