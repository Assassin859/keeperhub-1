/**
 * Renders a SitePage from lib/site/content.ts as server-side HTML.
 *
 * Deliberately a server component with no client boundary: these pages exist so
 * that a crawler with JavaScript disabled sees the full text, an H1, and the
 * links out to the machine-readable surfaces. Adding interactivity here would
 * quietly move the content back behind hydration.
 */

import Link from "next/link";
import type { SiteLink, SitePage, SiteSection } from "@/lib/site/content";

function isInternal(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function SiteAnchor({ link }: { link: SiteLink }): React.ReactElement {
  const className = "text-primary underline-offset-4 hover:underline";
  if (isInternal(link.href)) {
    return (
      <Link className={className} href={link.href}>
        {link.label}
      </Link>
    );
  }
  return (
    <a className={className} href={link.href} rel="noopener">
      {link.label}
    </a>
  );
}

function SectionBody({
  section,
}: {
  section: SiteSection;
}): React.ReactElement {
  return (
    <>
      {section.paragraphs?.map((paragraph) => (
        <p className="text-muted-foreground leading-relaxed" key={paragraph}>
          {paragraph}
        </p>
      ))}

      {section.bullets && (
        <ul className="list-disc space-y-2 pl-5 text-muted-foreground leading-relaxed">
          {section.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      )}

      {section.table && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-border border-b bg-card">
                {section.table.headers.map((header) => (
                  <th className="px-4 py-3 font-medium" key={header}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.table.rows.map((row) => (
                <tr
                  className="border-border border-b last:border-b-0"
                  key={row.join("|")}
                >
                  {row.map((cell, cellIndex) => (
                    <td
                      className="px-4 py-3 text-muted-foreground"
                      // Cell text repeats across columns (two "Custom" cells in
                      // one row), so the column index is the only stable key.
                      key={`${row.join("|")}-${section.table?.headers[cellIndex] ?? cellIndex}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section.code && (
        <pre className="overflow-x-auto rounded-lg border border-border bg-card p-4 font-mono text-xs">
          <code>{section.code.source}</code>
        </pre>
      )}

      {section.links && (
        <ul className="space-y-2 text-sm">
          {section.links.map((link) => (
            <li key={`${link.label}-${link.href}`}>
              <SiteAnchor link={link} />
              {link.description ? (
                <span className="text-muted-foreground">
                  {" — "}
                  {link.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * `pointer-events-auto fixed inset-0 ... bg-background` is how every full-screen
 * page in this app escapes the shell that LayoutContent wraps non-bare routes
 * in (see components/activity/activity-page.tsx). Without it the workflow canvas
 * shows through and the layout's `pointer-events-none` swallows every link.
 */
export function SitePageView({ page }: { page: SitePage }): React.ReactElement {
  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-background">
      <main className="mx-auto w-full max-w-3xl px-6 py-16">
        <header>
          <h1 className="font-semibold text-3xl tracking-tight">
            {page.heading}
          </h1>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            {page.description}
          </p>
        </header>

        {page.sections.map((section) => (
          <section className="mt-12 space-y-4" key={section.heading}>
            <h2 className="font-semibold text-xl tracking-tight">
              {section.heading}
            </h2>
            <SectionBody section={section} />
          </section>
        ))}

        <footer className="mt-16 border-border border-t pt-6 text-muted-foreground text-sm">
          <p>
            This page is also available as markdown. Request it with{" "}
            <code className="font-mono">Accept: text/markdown</code>.
          </p>
        </footer>
      </main>
    </div>
  );
}
