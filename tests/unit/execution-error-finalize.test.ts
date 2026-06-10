import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Minimal drizzle-orm stub — eq() just needs to not throw.
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

vi.mock("@/lib/db/schema", () => ({
  organization: { slug: "organization.slug", id: "organization.id" },
  workflows: { id: "workflows.id", organizationId: "workflows.organizationId" },
}));

vi.mock("@/lib/errors/classify", () => ({
  classifyExecutionError: vi.fn().mockReturnValue({
    errorCategory: "workflow_engine",
    errorType: "system" as const,
  }),
}));

vi.mock("@/lib/metrics/db-metrics", () => ({
  ANONYMOUS_ORG_SLUG: "_anonymous",
}));

const mockLimit = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: (...args: unknown[]) => mockLimit(...args),
          }),
        }),
      }),
    }),
  },
}));

import {
  getPrometheusMetrics,
  recordWorkflowExecutionErrorByWorkflow,
} from "@/lib/metrics/collectors/prometheus";

import { recordExecutionErrorFinalized } from "@/lib/errors/finalize-error";

describe("recordWorkflowExecutionErrorByWorkflow", () => {
  it("increments keeperhub_workflow_execution_errors_by_workflow_total with correct labels", async () => {
    recordWorkflowExecutionErrorByWorkflow({
      workflowId: "wf_test_abc",
      orgSlug: "acme",
      errorType: "system",
    });

    const output = await getPrometheusMetrics();

    expect(output).toContain(
      "keeperhub_workflow_execution_errors_by_workflow_total"
    );
    expect(output).toMatch(/workflow_id="wf_test_abc"/);
    expect(output).toMatch(/org_slug="acme"/);
    expect(output).toMatch(/error_type="system"/);
  });

  it("accepts error_type user as well as system", async () => {
    recordWorkflowExecutionErrorByWorkflow({
      workflowId: "wf_user_err",
      orgSlug: "beta-org",
      errorType: "user",
    });

    const output = await getPrometheusMetrics();

    expect(output).toMatch(/workflow_id="wf_user_err"/);
    expect(output).toMatch(/error_type="user"/);
  });
});

describe("recordExecutionErrorFinalized", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls both counters with the org slug resolved from the DB", async () => {
    mockLimit.mockResolvedValue([{ slug: "acme" }]);

    const prometheusMod = await import("@/lib/metrics/collectors/prometheus");
    const recordErrorSpy = vi.spyOn(prometheusMod, "recordWorkflowExecutionError");
    const recordByWorkflowSpy = vi.spyOn(
      prometheusMod,
      "recordWorkflowExecutionErrorByWorkflow"
    );

    await recordExecutionErrorFinalized({
      workflowId: "wf_abc123",
      errorMessage: "step execution failed",
    });

    expect(recordErrorSpy).toHaveBeenCalledWith({
      orgSlug: "acme",
      errorCategory: "workflow_engine",
      errorType: "system",
    });
    expect(recordByWorkflowSpy).toHaveBeenCalledWith({
      workflowId: "wf_abc123",
      orgSlug: "acme",
      errorType: "system",
    });
  });

  it("falls back to ANONYMOUS_ORG_SLUG when the DB returns no matching row", async () => {
    mockLimit.mockResolvedValue([]);

    const prometheusMod = await import("@/lib/metrics/collectors/prometheus");
    const recordErrorSpy = vi.spyOn(prometheusMod, "recordWorkflowExecutionError");
    const recordByWorkflowSpy = vi.spyOn(
      prometheusMod,
      "recordWorkflowExecutionErrorByWorkflow"
    );

    await recordExecutionErrorFinalized({
      workflowId: "wf_personal",
      errorMessage: null,
    });

    expect(recordErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: "_anonymous" })
    );
    expect(recordByWorkflowSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: "_anonymous", workflowId: "wf_personal" })
    );
  });

  it("swallows errors so a DB failure never breaks the finalize path", async () => {
    mockLimit.mockRejectedValue(new Error("DB connection lost"));

    await expect(
      recordExecutionErrorFinalized({
        workflowId: "wf_db_fail",
        errorMessage: "some error",
      })
    ).resolves.toBeUndefined();
  });
});
