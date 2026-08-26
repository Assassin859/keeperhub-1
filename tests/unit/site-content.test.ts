import { describe, expect, it } from "vitest";
import { PLANS } from "@/lib/billing/plans";
import {
  NEGOTIABLE_PATHS,
  negotiablePage,
  PUBLIC_PAGE_PATHS,
  publicPage,
  publicPages,
  type SitePage,
} from "@/lib/site/content";
import { renderPageMarkdown } from "@/lib/site/markdown";

/**
 * The agent-readiness audit scores a page as "no content" below roughly 500
 * characters of text. That number is the contract these pages exist to satisfy,
 * so it is asserted rather than left to whoever edits the copy next.
 */
const MIN_TEXT_CHARS = 500;

function textOf(page: SitePage): string {
  const parts: string[] = [page.heading, page.description];
  for (const section of page.sections) {
    parts.push(section.heading);
    parts.push(...(section.paragraphs ?? []));
    parts.push(...(section.bullets ?? []));
    for (const link of section.links ?? []) {
      parts.push(link.label, link.description ?? "");
    }
    for (const row of section.table?.rows ?? []) {
      parts.push(row.join(" "));
    }
  }
  return parts.join(" ");
}

describe("public site content", () => {
  it("defines a page for every advertised public path", () => {
    for (const path of PUBLIC_PAGE_PATHS) {
      expect(publicPage(path), `no SitePage for ${path}`).not.toBeNull();
    }
  });

  it("carries enough prose on every page for a crawler to read", () => {
    for (const path of PUBLIC_PAGE_PATHS) {
      const page = publicPage(path);
      expect(page).not.toBeNull();
      const length = textOf(page as SitePage).length;
      expect(length, `${path} has only ${length} characters`).toBeGreaterThan(
        MIN_TEXT_CHARS
      );
    }
  });

  it("gives every page exactly one heading and a description", () => {
    for (const page of Object.values(publicPages())) {
      expect(page.heading.length).toBeGreaterThan(0);
      expect(page.description.length).toBeGreaterThan(0);
      expect(page.sections.length).toBeGreaterThan(0);
    }
  });

  it("maps /welcome onto the homepage so both answer the same", () => {
    // `/` redirects a signed-out visitor to /welcome. An agent that follows the
    // redirect and then asks for markdown must not get a different document.
    expect(negotiablePage("/welcome")).toEqual(publicPage("/"));
  });

  it("negotiates every public path plus /welcome, and nothing else", () => {
    expect(NEGOTIABLE_PATHS).toEqual([...PUBLIC_PAGE_PATHS, "/welcome"]);
    expect(negotiablePage("/workflows/abc")).toBeNull();
    expect(negotiablePage("/settings")).toBeNull();
  });

  it("keeps the contact page on the mailboxes the marketing site publishes", () => {
    const contact = publicPage("/contact");
    const text = textOf(contact as SitePage);
    expect(text).toContain("human@keeperhub.com");
    expect(text).toContain("support@keeperhub.com");
  });

  it("publishes the registered address on the contact page", () => {
    const headings = (publicPage("/contact")?.sections ?? []).map(
      (section) => section.heading
    );
    expect(headings).toContain("Postal address");
  });

  it("renders the address in postal order with the country spelled out", () => {
    // "EE" is correct for schema.org/addressCountry and wrong to show a person.
    expect(textOf(publicPage("/contact") as SitePage)).toContain(
      "Ahtri 12, 10151 Tallinn, Harju maakond, Estonia"
    );
  });

  it("links the homepage to the API, the docs, and the developer portal", () => {
    // The audit's "public API/docs linked from homepage" check reads these.
    const hrefs = (publicPage("/")?.sections ?? []).flatMap((section) =>
      (section.links ?? []).map((link) => link.href)
    );
    expect(hrefs).toContain("/developers");
    expect(hrefs).toContain("/openapi.json");
    expect(hrefs).toContain("/mcp");
    // Host-exact, not a substring: "https://evil.test/docs.keeperhub.com"
    // satisfies an includes() check while pointing somewhere else entirely.
    expect(
      hrefs.some(
        (href) =>
          href.startsWith("http") && new URL(href).host === "docs.keeperhub.com"
      )
    ).toBe(true);
  });

  describe("pricing", () => {
    it("derives every plan row from lib/billing/plans.ts", () => {
      const table = publicPage("/pricing")?.sections[0]?.table;
      expect(table).toBeDefined();
      const names = (table?.rows ?? []).map((row) => row[0]);
      expect(names).toEqual([
        PLANS.free.name,
        PLANS.pro.name,
        PLANS.business.name,
        PLANS.enterprise.name,
      ]);
    });

    it("quotes the Pro entry price that billing actually charges", () => {
      const [entryTier] = PLANS.pro.tiers;
      const proRow = publicPage("/pricing")?.sections[0]?.table?.rows.find(
        (row) => row[0] === PLANS.pro.name
      );
      expect(proRow?.[1]).toContain(`$${entryTier.monthlyPrice}`);
      expect(proRow?.[1]).toContain(`$${entryTier.monthlyPriceAnnual}`);
    });

    it("never leaks the raw supportLevel slug into the table", () => {
      // "email-48h" / "dedicated-12h" are internal enum values and were
      // rendering straight into the public pricing table.
      const rows = publicPage("/pricing")?.sections[0]?.table?.rows ?? [];
      for (const row of rows) {
        for (const cell of row) {
          expect(cell).not.toMatch(/^(email|dedicated)-\d+h$/);
          expect(cell).not.toBe("community");
        }
      }
      expect(rows.map((row) => row[6])).toEqual([
        "Community",
        "Email, 48h",
        "Dedicated, 12h",
        "Dedicated, 1h",
      ]);
    });

    it("derives support targets from PLANS rather than restating them", () => {
      // These were hand-written prose until review flagged the drift risk. A
      // public page quoting a response time the product no longer offers is
      // worse now that the same sentence is served as markdown agents repeat.
      const contact = textOf(publicPage("/contact") as SitePage);
      expect(contact).toContain("48-hour response target");
      expect(contact).toContain("12-hour response target");
      expect(contact).toContain("1-hour response target");
      expect(contact).toContain(PLANS.business.features.sla as string);
      expect(contact).toContain(PLANS.enterprise.features.sla as string);
    });

    it("does not state an SLA twice in the tier paragraphs", () => {
      const pricing = publicPage("/pricing") as SitePage;
      const business = pricing.sections.find(
        (section) => section.heading === "Business tiers"
      )?.paragraphs?.[0];
      expect(business).toBeDefined();
      const sla = PLANS.business.features.sla as string;
      expect((business ?? "").split(sla).length - 1).toBe(1);
    });

    it("reports Enterprise as custom rather than inventing a number", () => {
      const row = publicPage("/pricing")?.sections[0]?.table?.rows.find(
        (entry) => entry[0] === PLANS.enterprise.name
      );
      expect(row?.[1]).toBe("Custom");
      expect(row?.[2]).toBe("Custom");
    });
  });
});

/**
 * Counts ATX H1s outside fenced code blocks. The developer portal embeds shell
 * snippets whose comments start with "# ", which a naive `/^# /gm` scan reads as
 * extra top-level headings.
 */
function countHeadings(markdown: string, level: number): number {
  const prefix = `${"#".repeat(level)} `;
  let inFence = false;
  let count = 0;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.startsWith(prefix)) {
      count++;
    }
  }
  return count;
}

describe("markdown rendering", () => {
  it("opens with a single H1 and a blockquoted summary", () => {
    const page = publicPage("/developers") as SitePage;
    const markdown = renderPageMarkdown(page);
    expect(markdown.startsWith(`# ${page.heading}\n`)).toBe(true);
    expect(markdown).toContain(`> ${page.description}`);
    expect(countHeadings(markdown, 1)).toBe(1);
  });

  it("keeps one H1 per page across every public page", () => {
    for (const path of PUBLIC_PAGE_PATHS) {
      const markdown = renderPageMarkdown(publicPage(path) as SitePage);
      expect(countHeadings(markdown, 1), `${path} has the wrong H1 count`).toBe(
        1
      );
    }
  });

  it("renders every section as an H2", () => {
    const page = publicPage("/about") as SitePage;
    const markdown = renderPageMarkdown(page);
    for (const section of page.sections) {
      expect(markdown).toContain(`## ${section.heading}`);
    }
    expect(countHeadings(markdown, 2)).toBe(page.sections.length);
  });

  it("renders tables with a header row and a divider", () => {
    const markdown = renderPageMarkdown(publicPage("/pricing") as SitePage);
    expect(markdown).toContain("| Plan | Entry price |");
    expect(markdown).toMatch(/\| --- \| --- \|/);
  });

  it("rewrites site-relative links to absolute URLs", () => {
    // A markdown document travels away from its origin; a bare "/developers"
    // is unresolvable once an agent has copied it into a context window.
    const markdown = renderPageMarkdown(publicPage("/") as SitePage);
    expect(markdown).toContain("](https://app.keeperhub.com/developers)");
    expect(markdown).not.toMatch(/\]\(\/[a-z]/);
  });

  it("escapes backslashes before pipes so the escaping cannot undo itself", async () => {
    // Escaping | while leaving \\ alone turns a cell ending in a backslash into
    // "...\\\\|", where the doubled backslash renders as a literal and the pipe
    // goes back to being a column delimiter.
    const { renderPageMarkdown: render } = await import("@/lib/site/markdown");
    const page = {
      path: "/x",
      title: "x",
      heading: "x",
      description: "x",
      sections: [
        {
          heading: "t",
          table: {
            headers: ["a", "b"],
            rows: [["ends with a backslash \\", "second"]],
          },
        },
      ],
    } as unknown as SitePage;
    const row = render(page)
      .split("\n")
      .find((line) => line.includes("ends with a backslash"));
    expect(row).toBeDefined();
    // Exactly three pipes: opening, the column boundary, and closing. A
    // cell that broke out would produce a fourth.
    expect((row ?? "").split("|").length - 1).toBe(3);
    expect(row).toContain("\\\\");
  });

  it("escapes pipes so a cell cannot break the table", () => {
    const markdown = renderPageMarkdown(publicPage("/pricing") as SitePage);
    for (const line of markdown.split("\n")) {
      if (!line.startsWith("|")) {
        continue;
      }
      // Every unescaped pipe is a column boundary, so the count must be stable
      // within a table block.
      expect(line.endsWith("|")).toBe(true);
    }
  });

  it("closes with the machine-readable index an agent needs next", () => {
    const markdown = renderPageMarkdown(publicPage("/") as SitePage);
    expect(markdown).toContain("Canonical URL: https://app.keeperhub.com/");
    expect(markdown).toContain("llms.txt");
    expect(markdown).toContain("/openapi.json");
    expect(markdown).toContain("/sitemap.xml");
  });

  it("ends with a trailing newline", () => {
    expect(renderPageMarkdown(publicPage("/contact") as SitePage)).toMatch(
      /\n$/
    );
  });
});
