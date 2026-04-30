import type { MetadataRoute } from "next";
import { db } from "@/lib/db";
import { publicTags } from "@/lib/db/schema";

const baseUrl =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

/**
 * Sitemap metadata route (HUB-12, HUB-13).
 *
 * Enumerates the public surface area:
 *   - root (/) and the Hub index (/hub)
 *   - one entry per row in `publicTags` as /hub/tags/{slug}
 *
 * Runs at build time (revalidates per the route segment cache); the
 * publicTags table is small (<100 expected rows) so an unbounded select
 * is safe today. If it grows beyond ~10k rows, switch to the paginated
 * sitemap-index pattern.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const tagRows = await db
    .select({ slug: publicTags.slug, createdAt: publicTags.createdAt })
    .from(publicTags);

  const tagEntries: MetadataRoute.Sitemap = tagRows.map((row) => ({
    url: `${baseUrl}/hub/tags/${row.slug}`,
    lastModified: row.createdAt,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/`,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/hub`,
      changeFrequency: "daily",
      priority: 0.9,
    },
  ];

  return [...staticEntries, ...tagEntries];
}
