#!/usr/bin/env tsx

/**
 * Static guard against docs-vs-code drift in the public API.
 *
 * For every (METHOD, /api/path) advertised inside a fenced ```http block
 * under docs/api/**.md, this script asserts that the corresponding
 * Next.js App Router route file (app/api/<segments>/route.ts) exists and
 * exports a handler for that method. Path parameters in docs (`{id}`) are
 * mapped to the filesystem convention (`[id]`).
 *
 * Exits non-zero on any drift. Also emits specs/api-coverage.json so the
 * post-deploy live HEAD check (deploy-keeperhub.yaml) reads the same
 * source of truth without re-parsing markdown in YAML.
 *
 * Routes that exist in code but appear in no docs file are surfaced as
 * warnings, not failures - many internal/cron/og/auth routes are
 * intentionally undocumented.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const DOCS_DIR = join(REPO_ROOT, "docs/api");
const APP_API_DIR = join(REPO_ROOT, "app/api");
const COVERAGE_OUT = join(REPO_ROOT, "specs/api-coverage.json");

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const HTTP_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

type DocumentedEndpoint = {
  method: HttpMethod;
  path: string; // canonical, with {param} placeholders
  source: string; // docs file (repo-relative)
  line: number; // 1-based line in source
};

type Drift =
  | {
      kind: "missing-file";
      endpoint: DocumentedEndpoint;
      expectedShape: string;
    }
  | {
      kind: "missing-method";
      endpoint: DocumentedEndpoint;
      routeFile: string;
    };

// Routes that intentionally have no public-facing docs page. We do NOT
// fail or warn on these when walking app/api/** in reverse.
const UNDOCUMENTED_PREFIX_ALLOWLIST: readonly string[] = [
  "/api/internal/",
  "/api/cron/",
  "/api/admin/",
  "/api/og/",
  "/api/metrics",
  "/api/auth/",
  "/api/oauth/",
  "/api/health",
  "/api/openapi",
  "/api/feedback", // platform internal feedback collector
  "/api/features",
  "/api/notifications/",
  "/api/billing/webhooks/", // 3rd-party callback surface
  "/api/agent-registry",
  "/api/protocols", // exposed via hub, not public REST docs
  "/api/supported-tokens",
  "/api/validate-token",
  "/api/web3/", // legacy alias under chains
  "/api/gas/",
  "/api/mcp/", // documented via MCP catalog, not REST docs
];

function walkFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkFiles(full, suffix));
    } else if (name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Parse every fenced ```http block in a markdown file and extract
 * (method, path) lines. Returns matches with 1-based line numbers.
 */
function parseDocsFile(absPath: string): DocumentedEndpoint[] {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split(/\r?\n/);
  const endpoints: DocumentedEndpoint[] = [];
  let inHttpBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^```http\b/.test(raw)) {
      inHttpBlock = true;
      continue;
    }
    if (inHttpBlock && raw.startsWith("```")) {
      inHttpBlock = false;
      continue;
    }
    if (!inHttpBlock) {
      continue;
    }
    const match = raw.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)/);
    if (!match) {
      continue;
    }
    const method = match[1] as HttpMethod;
    // Strip query string and trailing punctuation; we only validate the
    // route, not its query parameters.
    const rawPath = match[2].split("?")[0].replace(/[).,;]+$/u, "");
    const canonical = rawPath.replace(/\/+$/u, "");
    endpoints.push({
      method,
      path: canonical,
      source: relative(REPO_ROOT, absPath),
      line: i + 1,
    });
  }
  return endpoints;
}

/**
 * Map a canonical docs path like /api/workflows/{workflowId}/execute to
 * the Next.js App Router file location, allowing the docs param name to
 * differ from the filesystem param name (`{executionId}` in docs vs
 * `[id]` on disk is fine; only the URL pattern shape matters).
 *
 * Returns null when no route file matches the shape.
 */
function docsPathToRouteFile(
  canonicalPath: string,
  shapeIndex: Map<string, string>
): string | null {
  const shape = pathShape(canonicalPath);
  return shapeIndex.get(shape) ?? null;
}

/**
 * Collapse every dynamic segment (`{x}`, `[x]`, `[...x]`) to a stable
 * wildcard so /api/runs/{id} and /api/runs/[executionId] hash to the
 * same shape. Static segments are preserved verbatim.
 */
function pathShape(p: string): string {
  return p
    .split("/")
    .map((seg) => {
      if (/^\[\.\.\..+\]$/u.test(seg)) {
        return "**";
      }
      if (/^\[.+\]$/u.test(seg) || /^\{.+\}$/u.test(seg)) {
        return "*";
      }
      return seg;
    })
    .join("/");
}

/**
 * Walk app/api/**.route.ts(x) once and return:
 *   shapeIndex: path-shape -> route file (repo-relative)
 *   routeFiles: list of (absPath, route URL with {param} placeholders)
 */
function indexRouteFiles(): {
  shapeIndex: Map<string, string>;
  routeFiles: { abs: string; routePath: string }[];
} {
  const shapeIndex = new Map<string, string>();
  const routeFiles: { abs: string; routePath: string }[] = [];
  const files = walkFiles(APP_API_DIR, "route.ts").concat(
    walkFiles(APP_API_DIR, "route.tsx")
  );
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs);
    const routePath =
      "/" +
      rel
        .replace(/\\/g, "/")
        .replace(/^app\//u, "")
        .replace(/\/route\.tsx?$/u, "")
        .split("/")
        .map((seg) => seg.replace(/^\[(.+)\]$/u, "{$1}"))
        .join("/");
    routeFiles.push({ abs, routePath });
    const shape = pathShape(routePath);
    // First write wins; if two route files collide on shape (e.g.
    // `/api/workflow/{id}` and `/api/workflows/{id}` both collapse to
    // `/api/workflows/*` only if both literal segments match, which is
    // not the case here), the later one is silently ignored. The
    // un-documented warning pass surfaces any duplicate that mattered.
    if (!shapeIndex.has(shape)) {
      shapeIndex.set(shape, rel);
    }
  }
  return { shapeIndex, routeFiles };
}

/**
 * Read a route file and report which HTTP methods it exports. Matches
 * the three styles observed in the codebase:
 *   export async function GET(...) { ... }
 *   export const GET = requireOrganization(async (req, ctx) => { ... });
 *   export { POST } from "@/app/api/.../route";
 */
function exportedMethods(absRouteFile: string): Set<HttpMethod> {
  const text = readFileSync(absRouteFile, "utf8");
  const found = new Set<HttpMethod>();
  for (const method of HTTP_METHODS) {
    const fn = new RegExp(
      String.raw`(?:^|\n)\s*export\s+(?:async\s+)?function\s+${method}\s*\(`,
      "u"
    );
    const cnst = new RegExp(
      String.raw`(?:^|\n)\s*export\s+const\s+${method}\s*=`,
      "u"
    );
    // export { GET } from "..."; or export { GET, POST } from "...";
    // Match within the braces of a re-export, allowing aliases (GET as Foo).
    const reExport = new RegExp(
      String.raw`(?:^|\n)\s*export\s*\{[^}]*\b${method}\b[^}]*\}\s*from\b`,
      "u"
    );
    if (fn.test(text) || cnst.test(text) || reExport.test(text)) {
      found.add(method);
    }
  }
  return found;
}

function collectDocumentedEndpoints(): DocumentedEndpoint[] {
  if (!existsSync(DOCS_DIR)) {
    throw new Error(`docs/api directory not found at ${DOCS_DIR}`);
  }
  const docFiles = walkFiles(DOCS_DIR, ".md");
  const all = docFiles.flatMap(parseDocsFile);
  // Deduplicate (a path may be re-mentioned in the same file).
  const seen = new Set<string>();
  const out: DocumentedEndpoint[] = [];
  for (const ep of all) {
    const key = `${ep.method} ${ep.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(ep);
  }
  return out;
}

function validate(
  endpoints: DocumentedEndpoint[],
  shapeIndex: Map<string, string>
): Drift[] {
  const drifts: Drift[] = [];
  for (const ep of endpoints) {
    const routeFile = shapeIndex.get(pathShape(ep.path));
    if (!routeFile) {
      drifts.push({
        kind: "missing-file",
        endpoint: ep,
        expectedShape: pathShape(ep.path),
      });
      continue;
    }
    const methods = exportedMethods(join(REPO_ROOT, routeFile));
    if (!methods.has(ep.method)) {
      drifts.push({ kind: "missing-method", endpoint: ep, routeFile });
    }
  }
  return drifts;
}

/**
 * Walk app/api/**.route.ts and flag routes that are not mentioned in any
 * docs/api/**.md file. Allowlisted prefixes (internal, cron, og, auth,
 * etc.) are skipped silently. Output is warn-only.
 */
function reportUndocumentedRoutes(
  documentedShapes: ReadonlySet<string>,
  routeFiles: { abs: string; routePath: string }[]
): string[] {
  const warnings: string[] = [];
  for (const { abs, routePath } of routeFiles) {
    // The catch-all itself - never warn on it.
    if (routePath === "/api/{...slug}") {
      continue;
    }
    if (UNDOCUMENTED_PREFIX_ALLOWLIST.some((p) => routePath.startsWith(p))) {
      continue;
    }
    if (!documentedShapes.has(pathShape(routePath))) {
      const rel = relative(REPO_ROOT, abs);
      warnings.push(`warn: ${routePath} (${rel}) is not mentioned in docs/api`);
    }
  }
  return warnings.sort();
}

function writeCoverageArtifact(
  endpoints: DocumentedEndpoint[],
  shapeIndex: Map<string, string>
) {
  mkdirSync(dirname(COVERAGE_OUT), { recursive: true });
  // Stable ordering so the artifact diff is reviewable.
  const sorted = [...endpoints].sort((a, b) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)
  );
  const json = {
    endpoints: sorted.map((ep) => ({
      method: ep.method,
      path: ep.path,
      route_file: shapeIndex.get(pathShape(ep.path)) ?? null,
      source: ep.source,
      line: ep.line,
    })),
  };
  writeFileSync(COVERAGE_OUT, `${JSON.stringify(json, null, 2)}\n`);
}

function main(): number {
  const endpoints = collectDocumentedEndpoints();
  const { shapeIndex, routeFiles } = indexRouteFiles();
  const drifts = validate(endpoints, shapeIndex);
  writeCoverageArtifact(endpoints, shapeIndex);

  console.log(
    `Scanned ${endpoints.length} documented endpoints across docs/api/`
  );

  if (drifts.length > 0) {
    console.error("\nDRIFT detected:\n");
    for (const d of drifts) {
      const { method, path, source, line } = d.endpoint;
      const reason =
        d.kind === "missing-file"
          ? `no route file matches the URL pattern ${d.expectedShape}`
          : `${d.routeFile} exists but does not export ${method}`;
      console.error(`  ${method} ${path}`);
      console.error(`    documented in ${source}:${line}`);
      console.error(`    ${reason}\n`);
    }
  }

  const documentedShapes = new Set(endpoints.map((e) => pathShape(e.path)));
  const warnings = reportUndocumentedRoutes(documentedShapes, routeFiles);
  if (warnings.length > 0) {
    console.log(
      `\n${warnings.length} routes exist in code but are not in docs/api ` +
        "(warnings only):"
    );
    for (const w of warnings) {
      console.log(`  ${w}`);
    }
  }

  if (drifts.length > 0) {
    return 1;
  }
  console.log("\nNo docs-vs-code drift detected.");
  return 0;
}

process.exit(main());
