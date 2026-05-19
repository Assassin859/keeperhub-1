/**
 * KEEP-468: regression tests for the strict-mode template resolution path.
 *
 * Coverage:
 *   - tracker collects each unresolved category (no-node, no-data, no-path)
 *     when callers thread it through processTemplate / processTemplates
 *     / processCodeTemplates / extractTemplateParameters
 *   - assertResolved throws TemplateResolutionError in strict mode and is a
 *     no-op in legacy mode (env-flag-gated)
 *   - the displayPattern literal-passthrough is detected by the post-scan
 *     even when the resolver returned a plain string with `{{...}}` left in
 *
 * The hackathon scenario that motivated KEEP-468 is exercised end-to-end:
 * the literal `{{$trigger.input.ts}}` (n8n syntax, not the KH grammar) must
 * not flow through to a downstream action.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// KEEP-525 step 1: spy on logging + metrics to assert the legacy-mode
// telemetry shape (warn-level, dedicated counter, no engine-error bump).
// vi.hoisted is required because vi.mock factories are hoisted above the
// top-level statements, so plain const declarations cannot be referenced.
const { mockIncrementCounter, mockLogSystemWarn, mockLogSystemError } =
  vi.hoisted(() => ({
    mockIncrementCounter: vi.fn(),
    mockLogSystemWarn: vi.fn(),
    mockLogSystemError: vi.fn(),
  }));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: mockLogSystemError,
  logSystemWarn: mockLogSystemWarn,
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: mockIncrementCounter,
  }),
}));

import { processTemplate } from "@/lib/utils/template";
import {
  extractTemplateParameters,
  processCodeTemplates,
  processTemplates,
} from "@/lib/workflow/executor/executor.workflow";
import {
  assertResolved,
  createTracker,
  TemplateResolutionError,
} from "@/lib/workflow/executor/template-resolution";

const ENV_KEY = "KEEPERHUB_TEMPLATE_RESOLVE_MODE";
const UNRESOLVED_REF_MESSAGE = /Unresolved template reference/;
const LEGACY_COUNTER = "template.resolve.legacy_substitution.total";

const baseOutputs = {
  trigger: {
    label: "Trigger",
    data: { triggered: true, ts: 1_715_000_000 },
  },
};

afterEach(() => {
  process.env[ENV_KEY] = undefined;
  mockIncrementCounter.mockClear();
  mockLogSystemWarn.mockClear();
  mockLogSystemError.mockClear();
});

describe("processTemplate tracker (lib/utils/template)", () => {
  it("records no-node when the referenced node is absent", () => {
    const tracker = createTracker();
    const out = processTemplate(
      "{{@missing:Label.field}}",
      baseOutputs,
      tracker
    );
    expect(out).toBe("");
    expect(tracker.unresolved).toHaveLength(1);
    expect(tracker.unresolved[0]?.reason).toBe("no-node");
  });

  it("records no-path when the field is missing on a present node", () => {
    const tracker = createTracker();
    const out = processTemplate(
      "{{@trigger:Trigger.does.not.exist}}",
      baseOutputs,
      tracker
    );
    expect(out).toBe("");
    expect(tracker.unresolved[0]?.reason).toBe("no-path");
  });

  it("does not record when the reference resolves cleanly", () => {
    const tracker = createTracker();
    const out = processTemplate(
      "{{@trigger:Trigger.ts}}",
      baseOutputs,
      tracker
    );
    expect(out).toBe("1715000000");
    expect(tracker.unresolved).toHaveLength(0);
  });
});

describe("assertResolved (executor strict gate)", () => {
  it("throws TemplateResolutionError in strict mode (default)", () => {
    const tracker = createTracker();
    tracker.unresolved.push({
      token: "{{$trigger.input.ts}}",
      reason: "no-node",
      detail: "n8n-style syntax not supported",
    });
    expect(() =>
      assertResolved(tracker, { value: "" }, { actionType: "Webhook" })
    ).toThrow(TemplateResolutionError);
  });

  it("does not throw in legacy mode but emits a warn (no throw)", () => {
    process.env[ENV_KEY] = "legacy";
    const tracker = createTracker();
    tracker.unresolved.push({
      token: "{{@missing:Foo}}",
      reason: "no-node",
    });
    expect(() =>
      assertResolved(tracker, { value: "" }, { actionType: "Webhook" })
    ).not.toThrow();
  });

  // KEEP-525 step 1: legacy mode previously used logSystemError, which
  // bumped the generic engine-errors counter and paged on-call. The
  // dedicated counter below is what dashboards consume to quantify the
  // exposure window without alert noise.
  describe("KEEP-525: legacy-mode telemetry shape", () => {
    it("emits the dedicated counter with action_type + single reason label", () => {
      process.env[ENV_KEY] = "legacy";

      const tracker = createTracker();
      tracker.unresolved.push({
        token: "{{@missing:Foo}}",
        reason: "no-node",
      });
      assertResolved(tracker, { value: "" }, { actionType: "ENS Write" });

      expect(mockIncrementCounter).toHaveBeenCalledWith(LEGACY_COUNTER, {
        action_type: "ENS Write",
        reason: "no-node",
      });
      expect(mockLogSystemWarn).toHaveBeenCalledTimes(1);
    });

    it("labels the reason as 'mixed' when multiple distinct reasons fire", () => {
      process.env[ENV_KEY] = "legacy";

      const tracker = createTracker();
      tracker.unresolved.push({ token: "{{@missing:Foo}}", reason: "no-node" });
      tracker.unresolved.push({
        token: "{{@trigger:Trigger.bad}}",
        reason: "no-path",
      });
      assertResolved(tracker, { value: "" }, { actionType: "HTTP Request" });

      expect(mockIncrementCounter).toHaveBeenCalledWith(LEGACY_COUNTER, {
        action_type: "HTTP Request",
        reason: "mixed",
      });
    });

    it("does not call logSystemError in legacy mode (no on-call page)", () => {
      process.env[ENV_KEY] = "legacy";

      const tracker = createTracker();
      tracker.unresolved.push({
        token: "{{@missing:Foo}}",
        reason: "no-node",
      });
      assertResolved(tracker, { value: "" }, { actionType: "Webhook" });

      expect(mockLogSystemError).not.toHaveBeenCalled();
    });

    it("derives literal-leftover from post-scan and includes it in the reason label", () => {
      process.env[ENV_KEY] = "legacy";

      const tracker = createTracker();
      assertResolved(
        tracker,
        { value: "Address: {{Trigger.unknownField}}" },
        { actionType: "ENS Write" }
      );

      expect(mockIncrementCounter).toHaveBeenCalledWith(LEGACY_COUNTER, {
        action_type: "ENS Write",
        reason: "literal-leftover",
      });
    });

    it("defaults action_type label to 'unknown' when context omits it", () => {
      process.env[ENV_KEY] = "legacy";

      const tracker = createTracker();
      tracker.unresolved.push({
        token: "{{@missing:Foo}}",
        reason: "no-node",
      });
      assertResolved(tracker, { value: "" }, {});

      expect(mockIncrementCounter).toHaveBeenCalledWith(LEGACY_COUNTER, {
        action_type: "unknown",
        reason: "no-node",
      });
    });
  });

  it("detects displayPattern literal pass-through in strict mode", () => {
    const tracker = createTracker();
    expect(() =>
      assertResolved(
        tracker,
        { value: "Address: {{Trigger.unknownField}}" },
        { actionType: "ENS Write" }
      )
    ).toThrow(TemplateResolutionError);
  });

  it("flags the original Tradewise hackathon corruption case", () => {
    // Simulates the exact corruption: an n8n-style ref leaked into a string
    // value bound to an on-chain ENS write.
    const tracker = createTracker();
    const renderedConfig = {
      key: "site",
      value: "{{$trigger.input.ts}}",
    };
    expect(() =>
      assertResolved(tracker, renderedConfig, { actionType: "ENS Write" })
    ).toThrow(UNRESOLVED_REF_MESSAGE);
  });
});

describe("processTemplates strict integration", () => {
  it("flags display-format references that fall through to literal pass-through", () => {
    const tracker = createTracker();
    const result = processTemplates(
      { url: "https://api/{{Trigger.unknownField}}" },
      baseOutputs,
      tracker
    );
    // The historical behaviour leaves the literal in the rendered string.
    expect(result.url).toContain("{{Trigger.unknownField}}");
    expect(tracker.unresolved.some((u) => u.reason === "no-path")).toBe(true);
  });

  it("does not record when references resolve", () => {
    const tracker = createTracker();
    processTemplates({ ts: "{{@trigger:Trigger.ts}}" }, baseOutputs, tracker);
    expect(tracker.unresolved).toHaveLength(0);
  });
});

describe("processCodeTemplates strict integration", () => {
  it("records no-node and leaves the original token in the code (caught by post-scan)", () => {
    const tracker = createTracker();
    const out = processCodeTemplates(
      "const x = {{@missing:Foo.bar}};",
      baseOutputs,
      tracker
    );
    expect(out).toContain("{{@missing:Foo.bar}}");
    expect(tracker.unresolved[0]?.reason).toBe("no-node");
  });

  it("records no-data when the upstream node returned null", () => {
    const tracker = createTracker();
    const outputs = {
      upstream: { label: "Upstream", data: null },
    };
    const out = processCodeTemplates(
      "const x = {{@upstream:Upstream.value}};",
      outputs,
      tracker
    );
    expect(out).toContain("null");
    expect(tracker.unresolved[0]?.reason).toBe("no-data");
  });
});

describe("extractTemplateParameters strict integration", () => {
  it("records no-path when a referenced field does not resolve", () => {
    const tracker = createTracker();
    const { paramValues } = extractTemplateParameters(
      "SELECT * FROM t WHERE id = {{@trigger:Trigger.missing}}",
      baseOutputs,
      tracker
    );
    expect(paramValues).toEqual([null]);
    expect(tracker.unresolved[0]?.reason).toBe("no-path");
  });
});
