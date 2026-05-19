import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthenticateApiKey,
  mockAuthenticateOAuthToken,
  mockGetSession,
  mockGetOrgContext,
  mockOrgLookup,
  mockMemberLookup,
} = vi.hoisted(() => ({
  mockAuthenticateApiKey: vi.fn(),
  mockAuthenticateOAuthToken: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetOrgContext: vi.fn(),
  // KEEP-563: resolveSessionOrg looks up org by id-or-slug, then member by
  // (userId, organizationId). The select chain is select().from(table).where().limit().
  // We replay the same chain shape and feed each call from a pluggable mock so
  // tests can program the org / member resolution outcomes independently.
  mockOrgLookup: vi.fn(),
  mockMemberLookup: vi.fn(),
}));

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: mockGetOrgContext,
}));

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: mockAuthenticateOAuthToken,
}));

// Pull the call counter out of the closure so beforeEach can reset it.
const dbState = { selectCount: 0 };
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            dbState.selectCount += 1;
            return dbState.selectCount % 2 === 1
              ? mockOrgLookup()
              : mockMemberLookup();
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  member: {},
  organization: {},
}));

import {
  getDualAuthContext,
  resolveCreatorContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";

function makeRequest(
  headers: Record<string, string> = {},
  init: { method?: string; url?: string } = {}
): Request {
  return new Request(init.url ?? "http://localhost/test", {
    method: init.method ?? "GET",
    headers: new Headers(headers),
  });
}

describe("getDualAuthContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectCount = 0;
    mockAuthenticateOAuthToken.mockResolvedValue({ authenticated: false });
  });

  describe("OAuth authentication", () => {
    it("returns userId and organizationId from OAuth token", async () => {
      mockAuthenticateOAuthToken.mockResolvedValue({
        authenticated: true,
        userId: "user_oauth",
        organizationId: "org_oauth",
      });

      const result = await getDualAuthContext(makeRequest());

      expect(result).toEqual({
        userId: "user_oauth",
        organizationId: "org_oauth",
        authMethod: "oauth",
        apiKeyId: null,
      });
      expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
      expect(mockGetSession).not.toHaveBeenCalled();
    });
  });

  describe("API key authentication", () => {
    it("returns userId and organizationId from API key", async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        authenticated: true,
        organizationId: "org_123",
        userId: "user_creator",
      });

      const result = await getDualAuthContext(
        makeRequest({ Authorization: "Bearer kh_test" })
      );

      expect(result).toEqual({
        userId: "user_creator",
        organizationId: "org_123",
        authMethod: "api-key",
        apiKeyId: null,
      });
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("returns null userId when API key has no creator", async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        authenticated: true,
        organizationId: "org_123",
      });

      const result = await getDualAuthContext(makeRequest());

      expect(result).toEqual({
        userId: null,
        organizationId: "org_123",
        authMethod: "api-key",
        apiKeyId: null,
      });
    });

    it("propagates apiKeyId through to the auth context", async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        authenticated: true,
        organizationId: "org_123",
        userId: "user_creator",
        apiKeyId: "key-abc",
      });

      const result = await getDualAuthContext(makeRequest());

      expect(result).toEqual({
        userId: "user_creator",
        organizationId: "org_123",
        authMethod: "api-key",
        apiKeyId: "key-abc",
      });
    });

    it("ignores X-Organization-Id header (hard org-scoping)", async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        authenticated: true,
        organizationId: "org_native",
        userId: "user_creator",
      });

      const result = await getDualAuthContext(
        makeRequest({
          Authorization: "Bearer kh_test",
          "X-Organization-Id": "org_other",
        })
      );

      expect(result).toEqual({
        userId: "user_creator",
        organizationId: "org_native",
        authMethod: "api-key",
        apiKeyId: null,
      });
    });
  });

  describe("session authentication", () => {
    beforeEach(() => {
      mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
    });

    it("returns userId and organizationId from session", async () => {
      mockGetSession.mockResolvedValue({
        user: { id: "user_session" },
      });
      mockGetOrgContext.mockResolvedValue({
        organization: { id: "org_session" },
      });

      const result = await getDualAuthContext(makeRequest());

      expect(result).toEqual({
        userId: "user_session",
        organizationId: "org_session",
        authMethod: "session",
        apiKeyId: null,
      });
    });

    it("returns null organizationId when user has no org", async () => {
      mockGetSession.mockResolvedValue({
        user: { id: "user_no_org" },
      });
      mockGetOrgContext.mockResolvedValue({ organization: null });

      const result = await getDualAuthContext(makeRequest());

      expect(result).toEqual({
        userId: "user_no_org",
        organizationId: null,
        authMethod: "session",
        apiKeyId: null,
      });
    });

    describe("KEEP-563: X-Organization-Id override (session only)", () => {
      beforeEach(() => {
        mockGetSession.mockResolvedValue({ user: { id: "user_session" } });
        mockGetOrgContext.mockResolvedValue({
          organization: { id: "org_default" },
        });
      });

      it("honors header pointing at a different org the user is a member of", async () => {
        mockOrgLookup.mockResolvedValueOnce([{ id: "org_target" }]);
        mockMemberLookup.mockResolvedValueOnce([{ id: "member_row" }]);

        const result = await getDualAuthContext(
          makeRequest({ "X-Organization-Id": "target-slug" })
        );

        expect(result).toEqual({
          userId: "user_session",
          organizationId: "org_target",
          authMethod: "session",
          apiKeyId: null,
        });
      });

      it("rejects 403 when caller is not a member of the requested org", async () => {
        mockOrgLookup.mockResolvedValueOnce([{ id: "org_target" }]);
        mockMemberLookup.mockResolvedValueOnce([]);

        const result = await getDualAuthContext(
          makeRequest({ "X-Organization-Id": "other-org" })
        );

        expect(result).toEqual({
          error: "Not a member of organization: other-org",
          status: 403,
        });
      });

      it("rejects 404 when the requested org slug/id is unknown", async () => {
        mockOrgLookup.mockResolvedValueOnce([]);

        const result = await getDualAuthContext(
          makeRequest({ "X-Organization-Id": "ghost-org" })
        );

        expect(result).toEqual({
          error: "Unknown organization: ghost-org",
          status: 404,
        });
      });

      it("falls back to session default when header is absent", async () => {
        const result = await getDualAuthContext(makeRequest());

        expect(result).toEqual({
          userId: "user_session",
          organizationId: "org_default",
          authMethod: "session",
          apiKeyId: null,
        });
        expect(mockOrgLookup).not.toHaveBeenCalled();
        expect(mockMemberLookup).not.toHaveBeenCalled();
      });
    });
  });

  describe("no authentication", () => {
    beforeEach(() => {
      mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
      mockGetSession.mockResolvedValue(null);
    });

    it("returns 401 error when required (default)", async () => {
      const result = await getDualAuthContext(makeRequest());

      expect(result).toEqual({ error: "Unauthorized", status: 401 });
    });

    it("returns null values when not required", async () => {
      const result = await getDualAuthContext(makeRequest(), {
        required: false,
      });

      expect(result).toEqual({
        userId: null,
        organizationId: null,
        authMethod: "session",
        apiKeyId: null,
      });
    });
  });

  describe("auth priority", () => {
    it("prefers OAuth over API key and session", async () => {
      mockAuthenticateOAuthToken.mockResolvedValue({
        authenticated: true,
        userId: "user_oauth",
        organizationId: "org_oauth",
      });
      mockAuthenticateApiKey.mockResolvedValue({
        authenticated: true,
        organizationId: "org_apikey",
        userId: "user_apikey",
      });

      const result = await getDualAuthContext(makeRequest());

      expect(result).toEqual({
        userId: "user_oauth",
        organizationId: "org_oauth",
        authMethod: "oauth",
        apiKeyId: null,
      });
      expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
    });

    it("prefers API key over session when both present", async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        authenticated: true,
        organizationId: "org_apikey",
        userId: "user_apikey",
      });
      mockGetSession.mockResolvedValue({
        user: { id: "user_session" },
      });

      const result = await getDualAuthContext(makeRequest());

      expect(result).toEqual({
        userId: "user_apikey",
        organizationId: "org_apikey",
        authMethod: "api-key",
        apiKeyId: null,
      });
      expect(mockGetSession).not.toHaveBeenCalled();
    });
  });

  describe("session origin (CSRF defence-in-depth)", () => {
    beforeEach(() => {
      mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
      mockGetSession.mockResolvedValue({ user: { id: "user_session" } });
      mockGetOrgContext.mockResolvedValue({
        organization: { id: "org_session" },
      });
    });

    it("allows state-changing request with cookie and trusted origin", async () => {
      const result = await getDualAuthContext(
        makeRequest(
          {
            cookie: "better-auth.session_token=abc",
            origin: "http://localhost:3000",
          },
          { method: "POST" }
        )
      );

      expect(result).toEqual({
        userId: "user_session",
        organizationId: "org_session",
        authMethod: "session",
        apiKeyId: null,
      });
    });

    it("allows wildcard match (https://*.keeperhub.com)", async () => {
      const result = await getDualAuthContext(
        makeRequest(
          {
            cookie: "better-auth.session_token=abc",
            origin: "https://app.keeperhub.com",
          },
          { method: "POST" }
        )
      );

      expect(result).toEqual({
        userId: "user_session",
        organizationId: "org_session",
        authMethod: "session",
        apiKeyId: null,
      });
    });

    it("rejects state-changing request with cookie and untrusted origin", async () => {
      const result = await getDualAuthContext(
        makeRequest(
          {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
          },
          { method: "POST" }
        )
      );

      expect(result).toEqual({ error: "Invalid origin", status: 403 });
    });

    it("rejects state-changing request with cookie and no origin/referer", async () => {
      const result = await getDualAuthContext(
        makeRequest(
          { cookie: "better-auth.session_token=abc" },
          { method: "POST" }
        )
      );

      expect(result).toEqual({ error: "Invalid origin", status: 403 });
    });

    it("falls back to Referer when Origin is missing", async () => {
      const result = await getDualAuthContext(
        makeRequest(
          {
            cookie: "better-auth.session_token=abc",
            referer: "http://localhost:3000/some/page",
          },
          { method: "POST" }
        )
      );

      expect(result).toEqual({
        userId: "user_session",
        organizationId: "org_session",
        authMethod: "session",
        apiKeyId: null,
      });
    });

    it("allows GET requests regardless of origin (CSRF only blocks mutations)", async () => {
      const result = await getDualAuthContext(
        makeRequest(
          {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
          },
          { method: "GET" }
        )
      );

      expect(result).toEqual({
        userId: "user_session",
        organizationId: "org_session",
        authMethod: "session",
        apiKeyId: null,
      });
    });

    it("allows cookieless POST (Bearer-only callers)", async () => {
      const result = await getDualAuthContext(
        makeRequest({ origin: "https://evil.example.com" }, { method: "POST" })
      );

      expect(result).toEqual({
        userId: "user_session",
        organizationId: "org_session",
        authMethod: "session",
        apiKeyId: null,
      });
    });

    it("treats empty Cookie: header as no cookies", async () => {
      const result = await getDualAuthContext(
        makeRequest(
          { cookie: "", origin: "https://evil.example.com" },
          { method: "POST" }
        )
      );

      expect(result).toEqual({
        userId: "user_session",
        organizationId: "org_session",
        authMethod: "session",
        apiKeyId: null,
      });
    });

    it("bypasses origin check when only non-session cookies are present", async () => {
      // Bearer-API-key callers behind Cloudflare Access carry CF cookies but
      // no better-auth session. They reach getDualAuthContext as session-fall-
      // through (auth methods above already returned), but origin should not
      // gate them.
      const result = await getDualAuthContext(
        makeRequest(
          {
            cookie: "CF_AppSession=abc; CF_Authorization=xyz",
            origin: "https://evil.example.com",
          },
          { method: "POST" }
        )
      );

      expect(result).toEqual({
        userId: "user_session",
        organizationId: "org_session",
        authMethod: "session",
        apiKeyId: null,
      });
    });

    it("does not gate OAuth Bearer requests on origin", async () => {
      mockAuthenticateOAuthToken.mockResolvedValue({
        authenticated: true,
        userId: "user_oauth",
        organizationId: "org_oauth",
      });

      const result = await getDualAuthContext(
        makeRequest(
          {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
            Authorization: "Bearer token",
          },
          { method: "POST" }
        )
      );

      expect(result).toEqual({
        userId: "user_oauth",
        organizationId: "org_oauth",
        authMethod: "oauth",
        apiKeyId: null,
      });
    });
  });
});

describe("resolveOrganizationId — origin check wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectCount = 0;
    mockAuthenticateOAuthToken.mockResolvedValue({ authenticated: false });
    mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
    mockGetSession.mockResolvedValue({ user: { id: "user_session" } });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: "org_session" },
    });
  });

  it("rejects untrusted origin on cookie POST", async () => {
    const result = await resolveOrganizationId(
      makeRequest(
        {
          cookie: "better-auth.session_token=abc",
          origin: "https://evil.example.com",
        },
        { method: "POST" }
      )
    );
    expect(result).toEqual({ error: "Invalid origin", status: 403 });
  });

  it("allows trusted origin on cookie POST", async () => {
    const result = await resolveOrganizationId(
      makeRequest(
        {
          cookie: "better-auth.session_token=abc",
          origin: "http://localhost:3000",
        },
        { method: "POST" }
      )
    );
    expect(result).toEqual({
      organizationId: "org_session",
      authMethod: "session",
      apiKeyId: null,
    });
  });
});

describe("resolveCreatorContext — origin check wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectCount = 0;
    mockAuthenticateOAuthToken.mockResolvedValue({ authenticated: false });
    mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
    mockGetSession.mockResolvedValue({ user: { id: "user_session" } });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: "org_session" },
    });
  });

  it("rejects untrusted origin on cookie POST", async () => {
    const result = await resolveCreatorContext(
      makeRequest(
        {
          cookie: "better-auth.session_token=abc",
          origin: "https://evil.example.com",
        },
        { method: "POST" }
      )
    );
    expect(result).toEqual({ error: "Invalid origin", status: 403 });
  });

  it("allows trusted origin on cookie POST", async () => {
    const result = await resolveCreatorContext(
      makeRequest(
        {
          cookie: "better-auth.session_token=abc",
          origin: "http://localhost:3000",
        },
        { method: "POST" }
      )
    );
    expect(result).toEqual({
      organizationId: "org_session",
      userId: "user_session",
      authMethod: "session",
      apiKeyId: null,
    });
  });
});
