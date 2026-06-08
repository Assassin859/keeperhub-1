import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {},
  logSystemError: vi.fn(),
  logUserError: vi.fn(),
}));

import { sendWorkflowExecutionDigestEmail } from "@/lib/email";

const mockFetch = vi.fn();

function baseData() {
  return {
    to: "owner@example.com",
    orgName: "Acme",
    cadence: "daily" as const,
    appUrl: "https://app.keeperhub.com",
    stats: {
      total: 5,
      success: 3,
      error: 2,
      transactionCount: 4,
      gasUsedWei: "0",
    },
    topFailing: [
      {
        workflowId: "wf-fail",
        name: "Nightly sync",
        failures: 2,
        lastError: "boom",
      },
    ],
    mostExecuted: [{ workflowId: "wf-run", name: "Nightly sync", runs: 5 }],
  };
}

// Concatenate the text + html bodies sent to SendGrid for assertions.
function sentContent(): string {
  const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
  return (body.content ?? []).map((c: { value: string }) => c.value).join("\n");
}

describe("sendWorkflowExecutionDigestEmail", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", mockFetch);
    process.env.SENDGRID_API_KEY = "SG.test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.SENDGRID_API_KEY = undefined;
  });

  it("omits the sponsored section when sponsorship is off (count undefined)", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).not.toContain("Sponsored");
  });

  it("renders the sponsored section when a sponsored count is provided", async () => {
    const data = baseData();
    await sendWorkflowExecutionDigestEmail({
      ...data,
      stats: { ...data.stats, sponsoredTransactionCount: 7 },
    });
    const content = sentContent();
    expect(content).toContain("Sponsored txs");
    expect(content).toContain("Sponsored transactions: 7");
  });

  it("links each workflow to its page on the platform", async () => {
    await sendWorkflowExecutionDigestEmail(baseData());
    const content = sentContent();
    expect(content).toContain("https://app.keeperhub.com/workflows/wf-fail");
    expect(content).toContain("https://app.keeperhub.com/workflows/wf-run");
  });
});
