/**
 * Pure validators for the workflow listing flow.
 *
 * These functions inspect the workflow `nodes` payload and the desired
 * `inputSchema` to catch authoring mistakes that would otherwise reach the
 * bazaar in a broken state — e.g. an `@40` literal where the editor's `@`
 * autocomplete was dismissed mid-typing, or a listed workflow with a null
 * inputSchema (which leaves bazaar consumers unable to render or validate
 * inputs).
 *
 * Kept dependency-free so they're easy to unit-test without DB mocks.
 */

const TEMPLATE_PATTERN = /\{\{[^}]*\}\}/g;
// Match @<word>(-<word>)* preceded by start-of-string, whitespace, or a
// delimiter. Excludes intra-token @s (like email addresses).
const BARE_AT_PATTERN = /(?:^|[\s,;:([])(@\w+(?:-\w+)*)/g;

type NodeLike = {
  id?: unknown;
  type?: unknown;
  data?: {
    config?: { actionType?: unknown } & Record<string, unknown>;
  } & Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Returns the list of bare-@ literals found in workflow node configs.
 *
 * A bare-@ literal is an `@<word>` token that appears OUTSIDE a `{{...}}`
 * template wrapper — i.e. the trapped state when a user types `@` in the
 * editor and dismisses autocomplete before completing a `{{@nodeId:...}}`
 * reference. These would survive listing and silently break at runtime
 * because the executor only resolves wrapped templates.
 *
 * Nodes whose `data.config.actionType` starts with `code/` are skipped to
 * avoid false positives on TypeScript-style decorators inside user-authored
 * code blocks.
 */
export function findBareAtLiterals(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const findings: string[] = [];

  for (const node of nodes as NodeLike[]) {
    const actionType =
      typeof node?.data?.config?.actionType === "string"
        ? (node.data.config.actionType as string)
        : "";
    if (actionType.startsWith("code/")) {
      continue;
    }

    const config = node?.data?.config;
    if (config === undefined || config === null) {
      continue;
    }
    visit(config, findings);
  }

  return findings;
}

function visit(value: unknown, findings: string[]): void {
  if (typeof value === "string") {
    const stripped = value.replace(TEMPLATE_PATTERN, "");
    for (const m of stripped.matchAll(BARE_AT_PATTERN)) {
      findings.push(m[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, findings);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      visit(item, findings);
    }
  }
}

/**
 * Returns true if the given value is a non-null object that can serve as a
 * JSON-schema-shaped input declaration. Empty objects (e.g. `{type: "object"}`)
 * are accepted — the goal is to ensure the workflow declares *something* for
 * bazaar consumers to render, not to enforce schema completeness.
 */
export function isInputSchemaPresent(schema: unknown): boolean {
  return (
    typeof schema === "object" && schema !== null && !Array.isArray(schema)
  );
}
