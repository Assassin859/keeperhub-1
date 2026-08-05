import { describe, expect, it } from "vitest";
import { clearShareExecutionStatus } from "@/lib/workflow/share-execution-status";
import { softDeleteValues } from "@/lib/workflow/soft-delete";

describe("share execution status lifecycle helpers", () => {
  it("softDeleteValues clears shareExecutionStatus", () => {
    expect(softDeleteValues()).toEqual({
      deletedAt: expect.any(Date),
      isListed: false,
      shareExecutionStatus: false,
    });
  });

  it("clearShareExecutionStatus returns false", () => {
    expect(clearShareExecutionStatus()).toEqual({
      shareExecutionStatus: false,
    });
  });
});
