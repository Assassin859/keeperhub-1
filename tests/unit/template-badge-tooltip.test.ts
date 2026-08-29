import { describe, expect, it } from "vitest";
import { badgeTooltip } from "@/components/ui/template-badge-editor";
import {
  getDisplayTextForTemplate,
  type TemplateNode,
} from "@/lib/workflow/editor/template-utils";

const EDIT_HINT = "Double-click to edit this reference";

const nodes: TemplateNode[] = [
  {
    id: "JRY0lGfsvlwszZ797lIFz",
    data: { label: "Get hat execution", type: "action" },
  },
  { id: "sT1lFq2xKmA9dPn4vBc0e", data: { label: "Manual", type: "trigger" } },
];

describe("badgeTooltip", () => {
  it("leads with the reference and keeps the hint on its own line", () => {
    const tooltip = badgeTooltip("Get hat execution.result.timestamp");

    expect(tooltip.split("\n")).toEqual([
      "Get hat execution.result.timestamp",
      EDIT_HINT,
    ]);
  });

  it("keeps a long path whole, since the badge itself is clipped", () => {
    const long = "Get hat execution.result.receipt.logs.0.args.tokenId";

    expect(badgeTooltip(long).startsWith(`${long}\n`)).toBe(true);
  });

  it("falls back to the hint alone when there is no display text", () => {
    expect(badgeTooltip("")).toBe(EDIT_HINT);
  });
});

describe("badgeTooltip over a rendered reference", () => {
  it("shows the full text of a reference the field clips", () => {
    const template =
      "{{@JRY0lGfsvlwszZ797lIFz:Get hat execution.result.timestamp}}";
    const displayText = getDisplayTextForTemplate(template, nodes);

    // The badge renders this text and the operand field clips it; the first
    // tooltip line has to carry the same text in full.
    expect(displayText).toBe("Get hat execution.result.timestamp");
    expect(badgeTooltip(displayText)).toBe(`${displayText}\n${EDIT_HINT}`);
  });

  it("follows a renamed node rather than the label stored in the token", () => {
    const template = "{{@JRY0lGfsvlwszZ797lIFz:Old label.result.timestamp}}";
    const displayText = getDisplayTextForTemplate(template, nodes);

    expect(badgeTooltip(displayText).split("\n")[0]).toBe(
      "Get hat execution.result.timestamp"
    );
  });

  it("carries the reference of a badge whose node is gone", () => {
    const template = "{{@deletedNodeId:Deleted step.result.value}}";
    const displayText = getDisplayTextForTemplate(template, nodes);

    expect(badgeTooltip(displayText).split("\n")[0]).toBe(
      "Deleted step.result.value"
    );
  });

  it("covers a reference with no field path", () => {
    const template = "{{@sT1lFq2xKmA9dPn4vBc0e:Manual}}";
    const displayText = getDisplayTextForTemplate(template, nodes);

    expect(badgeTooltip(displayText)).toBe(`Manual\n${EDIT_HINT}`);
  });
});
