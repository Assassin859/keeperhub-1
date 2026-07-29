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

type NodeLike = {
  id?: unknown;
};

const NODE_PARAMETER_PATH =
  /^nodes\[(\d+)\](?:\.data)?(?:\.config(?:\.([^.[\]]+))?)?/;

/**
 * Adds editor navigation targets to server-side validation issues when their
 * parameter paths identify a specific workflow node.
 */
export function mapWorkflowValidationIssues(
  issues: WorkflowValidationIssue[] | undefined,
  nodes: NodeLike[]
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
