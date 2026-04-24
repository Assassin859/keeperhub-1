import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthenticateApiKey,
  mockAuthenticateOAuthToken,
  mockGetSession,
  mockGetOrgContext,
} = vi.hoisted(() => ({
  mockAuthenticateApiKey: vi.fn(),
  mockAuthenticateOAuthToken: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetOrgContext: vi.fn(),
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

import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/test", {
    headers: new Headers(headers),
  });
}

describe("getDualAuthContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      });
      expect(mockGetSession).not.toHaveBeenCalled();
    });
  });
});
