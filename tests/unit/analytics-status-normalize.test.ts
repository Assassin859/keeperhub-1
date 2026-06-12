import { describe, expect, it, vi } from "vitest";

// queries.ts is a server-only module that also pulls in the db client; stub
// both so the pure status helpers can be imported under vitest without
// resolving the server-only marker or opening a DB connection.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { normalizeStatus, workflowDbStatuses } from "@/lib/analytics/queries";

describe("normalizeStatus", () => {
  it("maps phantom workflow runs to pending", () => {
    expect(normalizeStatus("phantom", "workflow")).toBe("pending");
  });

  it("passes through the standard workflow statuses unchanged", () => {
    expect(normalizeStatus("pending", "workflow")).toBe("pending");
    expect(normalizeStatus("running", "workflow")).toBe("running");
    expect(normalizeStatus("success", "workflow")).toBe("success");
    expect(normalizeStatus("error", "workflow")).toBe("error");
    expect(normalizeStatus("cancelled", "workflow")).toBe("cancelled");
  });

  it("maps direct completed/failed onto success/error", () => {
    expect(normalizeStatus("completed", "direct")).toBe("success");
    expect(normalizeStatus("failed", "direct")).toBe("error");
  });
});

describe("workflowDbStatuses", () => {
  it("expands the pending filter to also match phantom rows", () => {
    expect(workflowDbStatuses("pending")).toEqual(["pending", "phantom"]);
  });

  it("leaves other statuses as a single-value filter", () => {
    expect(workflowDbStatuses("success")).toEqual(["success"]);
    expect(workflowDbStatuses("error")).toEqual(["error"]);
    expect(workflowDbStatuses("running")).toEqual(["running"]);
    expect(workflowDbStatuses("cancelled")).toEqual(["cancelled"]);
  });
});
