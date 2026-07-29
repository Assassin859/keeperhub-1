import { describe, expect, it } from "vitest";
import {
  mapWorkflowValidationIssues,
  type WorkflowValidationIssue,
} from "@/lib/workflow/editor/run-validation";

const nodes = [{ id: "trigger-1" }, { id: "action-1" }];

describe("mapWorkflowValidationIssues", () => {
  it("maps a node config path to its editor node and field", () => {
    const issues: WorkflowValidationIssue[] = [
      {
        code: "invalid-token-address",
        message: "Invalid contract address",
        parameterPath: "nodes[1].config.contractAddress",
      },
    ];

    expect(mapWorkflowValidationIssues(issues, nodes)).toEqual([
      {
        ...issues[0],
        nodeId: "action-1",
        fieldKey: "contractAddress",
      },
    ]);
  });

  it("maps nested config paths to the top-level editor field", () => {
    const issues: WorkflowValidationIssue[] = [
      {
        code: "invalid-token-address",
        message: "Invalid custom token address",
        parameterPath: "nodes[1].config.tokenConfig.customToken.address",
      },
    ];

    expect(mapWorkflowValidationIssues(issues, nodes)[0]).toMatchObject({
      nodeId: "action-1",
      fieldKey: "tokenConfig",
    });
  });

  it("leaves workflow-level issues without navigation targets", () => {
    const issue: WorkflowValidationIssue = {
      code: "empty-nodes-array",
      message: "Workflow has no nodes",
      parameterPath: "nodes",
    };

    expect(mapWorkflowValidationIssues([issue], nodes)).toEqual([issue]);
  });

  it("returns an empty array when the API omits the issues key", () => {
    expect(mapWorkflowValidationIssues(undefined, nodes)).toEqual([]);
  });
});
