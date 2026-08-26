import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { negotiate as appNegotiate } from "@/lib/site/accept";
import { AGENT_CRAWLER_USER_AGENTS } from "@/lib/site/crawlers";
import { negotiate as docsNegotiate } from "../../docs-site/lib/accept";
import { AGENT_CRAWLER_USER_AGENTS as docsCrawlers } from "../../docs-site/lib/crawlers";
import { mapContentFile } from "../../docs-site/scripts/emit-markdown.mjs";

/**
 * docs.keeperhub.com is built and shipped as its own image, and its Dockerfile
 * copies only `docs-site/` and `docs/`. The parent `lib/` is therefore absent at
 * both build and run time, so the Accept parser and the crawler allow-list have
 * to exist twice. These tests are what stops the two copies drifting.
 */
describe("docs Accept parser parity", () => {
  const HEADERS: (string | null)[] = [
    null,
    "",
    "   ",
    "*/*",
    "text/*",
    "text/markdown",
    "TEXT/MARKDOWN ;Q=0.9, text/html;q=0.1",
    "text/markdown;q=1.0, text/html;q=0.5",
    "text/markdown;q=0.8, text/html;q=0.8",
    "text/markdown;q=0, text/html",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "application/json",
    "*/*;q=0",
    "text/html;q=0, text/markdown;q=0",
    "*/*;q=0.1, text/markdown;q=0.9",
    "text/markdown;q=banana",
    "garbage, text/markdown;q=0.9",
  ];

  it("agrees with the app implementation on every header", () => {
    for (const header of HEADERS) {
      expect(
        docsNegotiate(header),
        `disagreement on Accept: ${JSON.stringify(header)}`
      ).toEqual(appNegotiate(header));
    }
  });

  it("still serves html to a browser and markdown to an agent", () => {
    // Guards against the two copies agreeing on the wrong answer.
    expect(
      docsNegotiate(
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      )
    ).toEqual({ kind: "html" });
    expect(docsNegotiate("text/markdown")).toEqual({ kind: "markdown" });
    expect(docsNegotiate("application/json")).toEqual({
      kind: "not-acceptable",
    });
  });
});

describe("docs crawler allow-list parity", () => {
  it("matches the app's list exactly", () => {
    // Both must also match rules 1 and 5 in the infrastructure repo's
    // cloudflare.tf; a UA invited in robots.txt and refused at the edge is
    // worse than either policy alone.
    expect([...docsCrawlers]).toEqual([...AGENT_CRAWLER_USER_AGENTS]);
  });

  it("excludes the crawlers the edge blocks everywhere", () => {
    for (const blocked of ["Bytespider", "Meta-ExternalAgent", "cohere-ai"]) {
      expect(docsCrawlers).not.toContain(blocked);
    }
  });
});

describe("docs middleware method handling", () => {
  it("negotiates on HEAD as well as GET, like the app proxy", () => {
    // The parity suite above compares negotiate() across the two copies but
    // not their callers, which is how this diverged unnoticed: docs gated on
    // `method === "GET"`, so HEAD answered with HTML headers while GET with
    // the same Accept answered Markdown.
    const source = readFileSync("docs-site/middleware.ts", "utf8");
    expect(source).toContain(
      'request.method === "GET" || request.method === "HEAD"'
    );
    expect(source).not.toContain(
      'if (request.method === "GET" && !isRscRequest'
    );
  });

  it("matches the app proxy, which also handles both", () => {
    const proxySource = readFileSync("proxy.ts", "utf8");
    expect(proxySource).toContain('method !== "GET" && method !== "HEAD"');
  });
});

describe("docs markdown emitter", () => {
  it("resolves a symlinked page rather than dropping it", async () => {
    // A symlink to a file fails readdir, and entry.isFile() reports the link
    // rather than its target - so the page was skipped with no error, and
    // would have rendered as HTML while 404ing on both .md routes.
    const source = readFileSync("docs-site/scripts/emit-markdown.mjs", "utf8");
    expect(source).toContain("const target = await stat(full)");
    expect(source).toContain("target?.isFile()");
  });

  it("emits one file per markdown page in the content tree", async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    const manifest = "docs-site/public/_md/manifest.json";
    expect(existsSync(manifest)).toBe(true);
    const { files } = JSON.parse(readFileSync(manifest, "utf8"));
    // Every emitted path ends in .md and none escapes the prefix.
    for (const file of files) {
      expect(file.endsWith(".md")).toBe(true);
      expect(file.startsWith("..")).toBe(false);
    }
    expect(files.length).toBeGreaterThan(100);
    expect(readdirSync("docs-site/public/_md").length).toBeGreaterThan(0);
  });
});

describe("docs content-file to URL mapping", () => {
  it("maps the site root to index.md", () => {
    expect(mapContentFile("index.md")).toEqual({
      route: "/",
      output: "index.md",
    });
  });

  it("maps a section index to the section's own .md", () => {
    // /api is a page in its own right, so its Markdown twin is /api.md rather
    // than /api/index.md.
    expect(mapContentFile("api/index.md")).toEqual({
      route: "/api",
      output: "api.md",
    });
  });

  it("maps a leaf page alongside its siblings", () => {
    expect(mapContentFile("api/authentication.md")).toEqual({
      route: "/api/authentication",
      output: "api/authentication.md",
    });
  });

  it("maps a deeply nested page", () => {
    expect(mapContentFile("cli/commands/kh_auth.md")).toEqual({
      route: "/cli/commands/kh_auth",
      output: "cli/commands/kh_auth.md",
    });
  });

  it("preserves case, because the routes are case-sensitive", () => {
    // /FAQ serves 200 and /faq serves 404 on the live site.
    expect(mapContentFile("FAQ.md")).toEqual({
      route: "/FAQ",
      output: "FAQ.md",
    });
  });

  it("handles .mdx the same as .md", () => {
    expect(mapContentFile("guides/example.mdx")).toEqual({
      route: "/guides/example",
      output: "guides/example.md",
    });
  });
});
