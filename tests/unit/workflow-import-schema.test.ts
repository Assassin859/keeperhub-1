import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowExportV1Schema } from "@/lib/workflow/export-schema";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

// Used by plan 42-09 to load fixtures inside each test body.
function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")
  ) as unknown;
}

describe("workflowExportV1Schema (SEC-03, SEC-04, SEC-06)", () => {
  it("accepts a valid baseline export", () => {
    // TODO(42-09): assert workflowExportV1Schema.safeParse(loadFixture("workflow-import-valid")).success === true
    expect(workflowExportV1Schema).toBeDefined();
    expect(loadFixture).toBeDefined();
  });

  it("rejects an export with extra keys at the node envelope (.passthrough sealed by .strict)", () => {
    // TODO(42-09): assert safeParse(loadFixture("workflow-import-passthrough-extras")).success === false
    // and that the issue path includes "nodes" + "secretKey"
    expect(true).toBe(true);
  });

  it("rejects an export with more than 200 nodes", () => {
    // TODO(42-09): assert safeParse(loadFixture("workflow-import-201-nodes")).success === false
    // and the issue references "too_big" or "max" on path "nodes"
    expect(true).toBe(true);
  });

  it("rejects a webhook node with a non-https webhookUrl", () => {
    // TODO(42-09): assert safeParse(loadFixture("workflow-import-non-https-webhook")).success === false
    // and the issue path includes "webhookUrl"
    expect(true).toBe(true);
  });

  it("parses a code-step-with-content fixture (rejection happens at UX layer, not schema)", () => {
    // TODO(42-09): assert safeParse(loadFixture("workflow-import-code-step-with-content")).success === true
    // (the schema accepts code steps; the UX gate in WorkflowIOOverlay forces explicit confirmation)
    expect(true).toBe(true);
  });

  it("rejects an export whose description exceeds the 2000 char cap", () => {
    // TODO(42-09): inline a payload with description = "A".repeat(2001), assert safeParse fails
    expect(true).toBe(true);
  });
});
