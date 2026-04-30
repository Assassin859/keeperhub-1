import { describe, expect, it } from "vitest";

import {
  isReservedSlug,
  RESERVED_SLUGS,
} from "@/lib/workflow/reserved-slugs";

describe("RESERVED_SLUGS", () => {
  it("contains exactly 9 entries in the documented order", () => {
    expect(RESERVED_SLUGS).toEqual([
      "tags",
      "protocol",
      "marketplace",
      "auth",
      "api",
      "admin",
      "_next",
      "og",
      "well-known",
    ]);
    expect(RESERVED_SLUGS).toHaveLength(9);
  });

  it("contains every entry exactly once (no duplicates)", () => {
    const unique = new Set<string>(RESERVED_SLUGS);
    expect(unique.size).toBe(RESERVED_SLUGS.length);
  });
});

describe("isReservedSlug", () => {
  it("returns true for the lowercase reserved slug 'tags'", () => {
    expect(isReservedSlug("tags")).toBe(true);
  });

  it("returns true for upper-case 'TAGS' (case-insensitive)", () => {
    expect(isReservedSlug("TAGS")).toBe(true);
  });

  it("returns true for mixed-case 'Marketplace' (case-insensitive)", () => {
    expect(isReservedSlug("Marketplace")).toBe(true);
  });

  it("returns false for a non-reserved slug like 'defi'", () => {
    expect(isReservedSlug("defi")).toBe(false);
  });

  it("returns false for the empty string", () => {
    expect(isReservedSlug("")).toBe(false);
  });

  it("treats every entry in RESERVED_SLUGS as reserved", () => {
    for (const slug of RESERVED_SLUGS) {
      expect(isReservedSlug(slug)).toBe(true);
    }
  });
});
