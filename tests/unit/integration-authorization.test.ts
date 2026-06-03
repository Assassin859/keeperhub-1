/**
 * Per-integration authorization (KEEP-613).
 *
 * The pure rule table (isIntegrationUsable) is the security boundary that
 * gates credential use on the executing principal's grant rather than mere
 * shared-org membership. filterUnauthorizedIntegrationIds wires that rule to
 * batched DB lookups; it is tested with the db client and membership helper
 * mocked so the suite stays hermetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { fixtures, mockIsMember } = vi.hoisted(() => ({
  fixtures: {
    integrations: [] as unknown[],
    grants: [] as unknown[],
    users: [] as unknown[],
  },
  mockIsMember: vi.fn<(userId: string, orgId: string) => Promise<boolean>>(),
}));

// Dispatch the db.select().from(table).where() chain by drizzle's table-name
// symbol so the three batched queries resolve to their own fixtures.
const DRIZZLE_NAME = Symbol.for("drizzle:Name");
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: Record<symbol, string>) => ({
        where: () => {
          const name = table[DRIZZLE_NAME];
          if (name === "integrations") {
            return Promise.resolve(fixtures.integrations);
          }
          if (name === "integration_grants") {
            return Promise.resolve(fixtures.grants);
          }
          if (name === "users") {
            return Promise.resolve(fixtures.users);
          }
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

vi.mock("@/lib/workflow/access", () => ({
  isUserMemberOfOrganization: mockIsMember,
}));

import {
  filterUnauthorizedIntegrationIds,
  type IntegrationAuthRow,
  isIntegrationUsable,
} from "@/lib/integrations/authorization";

const NO_CTX = {
  isOwnerDeactivated: false,
  isPrincipalMember: false,
  hasGrant: false,
};

function row(overrides: Partial<IntegrationAuthRow>): IntegrationAuthRow {
  return {
    id: "int_1",
    userId: "owner_1",
    organizationId: "org_1",
    visibility: "private",
    ...overrides,
  };
}

describe("isIntegrationUsable", () => {
  it("allows the owner to use their own private integration", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "private" }),
        { userId: "owner_1", organizationId: "org_1" },
        NO_CTX
      )
    ).toBe(true);
  });

  it("denies a non-owner on a private integration (the closed lateral-movement path)", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "private" }),
        { userId: "member_b", organizationId: "org_1" },
        { ...NO_CTX, isPrincipalMember: true }
      )
    ).toBe(false);
  });

  it("allows an org member on an organization-visible integration in the same org", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization" }),
        { userId: "member_b", organizationId: "org_1" },
        { ...NO_CTX, isPrincipalMember: true }
      )
    ).toBe(true);
  });

  it("denies a non-member on an organization-visible integration", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization" }),
        { userId: "member_b", organizationId: "org_1" },
        { ...NO_CTX, isPrincipalMember: false }
      )
    ).toBe(false);
  });

  it("denies when the principal's org differs from the integration's org", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization", organizationId: "org_1" }),
        { userId: "member_b", organizationId: "org_2" },
        { ...NO_CTX, isPrincipalMember: true }
      )
    ).toBe(false);
  });

  it("denies organization visibility when the integration has no org", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization", organizationId: null }),
        { userId: "member_b", organizationId: null },
        { ...NO_CTX, isPrincipalMember: true }
      )
    ).toBe(false);
  });

  it("allows a specific member only when a grant exists", () => {
    const integration = row({ visibility: "specific_members" });
    const principal = { userId: "member_b", organizationId: "org_1" };
    expect(
      isIntegrationUsable(integration, principal, { ...NO_CTX, hasGrant: true })
    ).toBe(true);
    expect(
      isIntegrationUsable(integration, principal, {
        ...NO_CTX,
        hasGrant: false,
      })
    ).toBe(false);
  });

  it("freezes credentials when the owner is deactivated, even for the owner-context principal", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization" }),
        { userId: "owner_1", organizationId: "org_1" },
        { ...NO_CTX, isOwnerDeactivated: true, isPrincipalMember: true }
      )
    ).toBe(false);
  });
});

describe("filterUnauthorizedIntegrationIds", () => {
  beforeEach(() => {
    fixtures.integrations = [];
    fixtures.grants = [];
    fixtures.users = [];
    mockIsMember.mockReset();
    mockIsMember.mockResolvedValue(false);
  });

  it("returns nothing for an empty id list without querying", async () => {
    expect(
      await filterUnauthorizedIntegrationIds([], {
        userId: "u",
        organizationId: "o",
      })
    ).toEqual([]);
  });

  it("treats non-existent ids as authorized (stale references stay savable)", async () => {
    fixtures.integrations = [];
    expect(
      await filterUnauthorizedIntegrationIds(["missing"], {
        userId: "member_b",
        organizationId: "org_1",
      })
    ).toEqual([]);
  });

  it("flags a private integration referenced by a same-org non-owner (regression guard)", async () => {
    fixtures.integrations = [
      {
        id: "int_1",
        userId: "owner_1",
        organizationId: "org_1",
        visibility: "private",
      },
    ];
    mockIsMember.mockResolvedValue(true);

    expect(
      await filterUnauthorizedIntegrationIds(["int_1"], {
        userId: "member_b",
        organizationId: "org_1",
      })
    ).toEqual(["int_1"]);
  });

  it("authorizes an org-visible integration for a member but flags one without a grant", async () => {
    fixtures.integrations = [
      {
        id: "org_int",
        userId: "owner_1",
        organizationId: "org_1",
        visibility: "organization",
      },
      {
        id: "specific_int",
        userId: "owner_1",
        organizationId: "org_1",
        visibility: "specific_members",
      },
    ];
    fixtures.grants = []; // member_b has no grant on specific_int
    mockIsMember.mockResolvedValue(true);

    expect(
      await filterUnauthorizedIntegrationIds(["org_int", "specific_int"], {
        userId: "member_b",
        organizationId: "org_1",
      })
    ).toEqual(["specific_int"]);
  });

  it("flags every integration whose owner is deactivated", async () => {
    fixtures.integrations = [
      {
        id: "org_int",
        userId: "owner_1",
        organizationId: "org_1",
        visibility: "organization",
      },
    ];
    fixtures.users = [{ id: "owner_1" }]; // owner_1 is deactivated
    mockIsMember.mockResolvedValue(true);

    expect(
      await filterUnauthorizedIntegrationIds(["org_int"], {
        userId: "member_b",
        organizationId: "org_1",
      })
    ).toEqual(["org_int"]);
  });
});

// The org owns workflows: every workflow gate and the runtime credential
// fetch authorize as the ORG principal (userId null + the workflow's org).
describe("org principal", () => {
  const ORG_PRINCIPAL = { userId: null, organizationId: "org_1" };

  it("uses its own org-visible integration without a membership check", () => {
    expect(
      isIntegrationUsable(row({ visibility: "organization" }), ORG_PRINCIPAL, {
        ...NO_CTX,
        isPrincipalMember: false,
      })
    ).toBe(true);
  });

  it("is denied on another org's organization-visible integration", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization", organizationId: "org_2" }),
        ORG_PRINCIPAL,
        NO_CTX
      )
    ).toBe(false);
  });

  it("is denied on a private integration (personal credentials never resolve)", () => {
    expect(
      isIntegrationUsable(row({ visibility: "private" }), ORG_PRINCIPAL, NO_CTX)
    ).toBe(false);
  });

  it("is denied on specific_members (grants are per-user)", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "specific_members" }),
        ORG_PRINCIPAL,
        NO_CTX
      )
    ).toBe(false);
  });

  it("is still frozen when the integration's creator is deactivated", () => {
    expect(
      isIntegrationUsable(row({ visibility: "organization" }), ORG_PRINCIPAL, {
        ...NO_CTX,
        isOwnerDeactivated: true,
      })
    ).toBe(false);
  });

  it("a fully-null principal is denied everything", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization" }),
        { userId: null, organizationId: null },
        NO_CTX
      )
    ).toBe(false);
  });

  it("filterUnauthorizedIntegrationIds authorizes org-visible, flags private and specific_members", async () => {
    fixtures.integrations = [
      {
        id: "org_int",
        userId: "owner_1",
        organizationId: "org_1",
        visibility: "organization",
      },
      {
        id: "private_int",
        userId: "owner_1",
        organizationId: "org_1",
        visibility: "private",
      },
      {
        id: "specific_int",
        userId: "owner_1",
        organizationId: "org_1",
        visibility: "specific_members",
      },
    ];
    fixtures.grants = [];
    fixtures.users = [];
    mockIsMember.mockResolvedValue(false); // must not be consulted for the org principal

    expect(
      await filterUnauthorizedIntegrationIds(
        ["org_int", "private_int", "specific_int"],
        ORG_PRINCIPAL
      )
    ).toEqual(["private_int", "specific_int"]);
  });
});
