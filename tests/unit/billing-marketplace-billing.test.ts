import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  billableWorkflowFilter,
  billableWorkflowRawSql,
  FREE_MARKETPLACE_BILLING_THRESHOLD_USDC,
} from "@/lib/billing/marketplace-billing";

const dialect = new PgDialect();

describe("marketplace-billing", () => {
  it("threshold is 0.05 USDC", () => {
    expect(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC).toBe("0.05");
  });

  describe("billableWorkflowRawSql", () => {
    it("excludes listed workflows priced at or above the threshold (uses w. alias)", () => {
      const { sql } = dialect.sqlToQuery(billableWorkflowRawSql());
      const normalized = sql.replace(/\s+/g, " ").toLowerCase();

      expect(normalized).toContain("not (");
      expect(normalized).toContain("w.is_listed = true");
      expect(normalized).toContain(
        "coalesce(w.price_usdc_per_call::numeric, 0) >= 0.05::numeric"
      );
    });
  });

  describe("billableWorkflowFilter", () => {
    it("excludes listed workflows priced at or above the threshold (uses workflows table)", () => {
      const { sql } = dialect.sqlToQuery(billableWorkflowFilter());
      const normalized = sql.replace(/\s+/g, " ").toLowerCase();

      expect(normalized).toContain("not (");
      expect(normalized).toContain('"workflows"."is_listed" = true');
      expect(normalized).toContain(
        'coalesce("workflows"."price_usdc_per_call"::numeric, 0) >= 0.05::numeric'
      );
    });
  });
});
