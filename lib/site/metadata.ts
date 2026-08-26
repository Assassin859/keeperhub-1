/**
 * Metadata for the public pages, derived from the same SitePage the body is
 * rendered from.
 *
 * The canonical link is the reason this exists as a helper rather than a literal
 * per page: agents use `rel=canonical` for entity resolution and attribution,
 * and a canonical that points at the wrong origin is worse than none. Deriving
 * it from the page path against the configured app URL means a self-hosted
 * deployment canonicalises to itself instead of to app.keeperhub.com.
 */

import type { Metadata } from "next";
import { publicPage } from "@/lib/site/content";

export function siteMetadata(path: string): Metadata {
  const page = publicPage(path);
  if (!page) {
    return {};
  }
  return {
    title: page.title,
    description: page.description,
    // Relative to metadataBase, which app/layout.tsx sets from
    // NEXT_PUBLIC_APP_URL.
    alternates: { canonical: page.path },
    openGraph: {
      type: "website",
      siteName: "KeeperHub",
      title: page.title,
      description: page.description,
      url: page.path,
      images: [
        {
          url: "/api/og/default",
          width: 1200,
          height: 630,
          alt: page.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
      images: ["/api/og/default"],
    },
  };
}
