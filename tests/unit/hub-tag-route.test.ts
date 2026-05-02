import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/navigation BEFORE the module under test imports it.
const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

// Mock @/lib/db. Each test sets up its own resolved value so the chained
// .from(...).where(...).limit(...) and .from(...).where(...) shapes
// behave like the production query builder.
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "@/lib/db";

type TagRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
};

function setupSelect(tagRows: TagRow[], workflowsCount: number): void {
  // First select: from(publicTags).where(...).limit(1) -> tagRows
  // Second select: select({value: count()}).from(workflowPublicTags).where(...) -> [{value: workflowsCount}]
  const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
  selectMock.mockImplementation((arg?: unknown) => {
    if (arg && typeof arg === "object" && "value" in (arg as object)) {
      // count() shape — returns [{ value: number }]
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ value: workflowsCount }]),
        }),
      };
    }
    // tag select shape — returns the tag rows
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(tagRows),
        }),
      }),
    };
  });
}

function setupSelectAllSlugs(slugs: string[]): void {
  const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
  selectMock.mockImplementation(() => ({
    from: vi.fn().mockResolvedValue(slugs.map((slug) => ({ slug }))),
  }));
}

const seededTag: TagRow = {
  id: "tag_defi",
  name: "DeFi",
  slug: "defi",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("app/hub/tags/[tag]/page.tsx", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe("generateMetadata", () => {
    it("returns tag-specific title, description, and canonical for a valid tag", async () => {
      setupSelect([seededTag], 5);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const params = Promise.resolve({ tag: "defi" });
      const metadata = await mod.generateMetadata({ params });
      expect(metadata.title).toBe("DeFi templates · KeeperHub Hub");
      expect(metadata.description).toContain("DeFi");
      expect(metadata.alternates?.canonical).toBe("/hub/tags/defi");
    });

    it("emits robots: { index: false, follow: true } for empty tag pages (HUB-14)", async () => {
      setupSelect([seededTag], 0);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const params = Promise.resolve({ tag: "defi" });
      const metadata = await mod.generateMetadata({ params });
      expect(metadata.robots).toEqual({ index: false, follow: true });
    });

    it("does NOT set robots noindex when the tag has at least one workflow", async () => {
      setupSelect([seededTag], 3);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const params = Promise.resolve({ tag: "defi" });
      const metadata = await mod.generateMetadata({ params });
      expect(metadata.robots).toBeUndefined();
    });

    it("returns a not-found title for an unknown slug", async () => {
      setupSelect([], 0);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const params = Promise.resolve({ tag: "no-such-tag" });
      const metadata = await mod.generateMetadata({ params });
      expect(metadata.title).toContain("not found");
    });

    it("returns a not-found title for a reserved slug", async () => {
      // Don't even hit the DB if the slug is reserved.
      setupSelect([], 0);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const params = Promise.resolve({ tag: "tags" });
      const metadata = await mod.generateMetadata({ params });
      expect(metadata.title).toContain("not found");
    });

    it("uses the default Hub OG image (per-tag OG deferred to HUB-FUTURE-02)", async () => {
      setupSelect([seededTag], 5);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const params = Promise.resolve({ tag: "defi" });
      const metadata = await mod.generateMetadata({ params });
      const images = metadata.openGraph?.images;
      const firstImage = Array.isArray(images) ? images[0] : images;
      const ogImageUrl =
        firstImage && typeof firstImage === "object" && "url" in firstImage
          ? firstImage.url
          : "";
      expect(String(ogImageUrl)).toMatch(/\/api\/og\/hub$/);
    });
  });

  describe("generateStaticParams", () => {
    it("returns one entry per public tag row", async () => {
      setupSelectAllSlugs(["defi", "monitoring", "nft"]);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const result = await mod.generateStaticParams();
      expect(result).toEqual([
        { tag: "defi" },
        { tag: "monitoring" },
        { tag: "nft" },
      ]);
    });
  });

  describe("route segment config", () => {
    it("exports dynamicParams = true (HUB-10 — new tags render on demand)", async () => {
      const mod = await import("@/app/hub/tags/[tag]/page");
      expect(mod.dynamicParams).toBe(true);
    });

    it('exports dynamic = "force-dynamic" so notFound() yields 404 in prod (was a 500 under SSG + revalidate + dynamicParams)', async () => {
      const mod = await import("@/app/hub/tags/[tag]/page");
      expect(mod.dynamic).toBe("force-dynamic");
    });
  });

  describe("default page handler", () => {
    it("calls notFound() for a reserved slug", async () => {
      setupSelect([], 0);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const params = Promise.resolve({ tag: "tags" });
      await expect(
        mod.default({ params })
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFoundMock).toHaveBeenCalled();
    });

    it("calls notFound() for an unknown slug", async () => {
      setupSelect([], 0);
      const mod = await import("@/app/hub/tags/[tag]/page");
      const params = Promise.resolve({ tag: "no-such-tag" });
      await expect(
        mod.default({ params })
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFoundMock).toHaveBeenCalled();
    });
  });
});
