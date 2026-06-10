import { symmetricEncrypt } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_KEY = "kha_test-secret-key-12345";
const TEST_EMAIL = "test@techops.services";
const TEST_BETTER_AUTH_SECRET = "test-better-auth-secret-32-chars!";

async function encryptOtp(otp: string): Promise<string> {
  return await symmetricEncrypt({ key: TEST_BETTER_AUTH_SECRET, data: otp });
}

let mockResult: unknown[] = [];
let mockShouldThrow = false;

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => {
              if (mockShouldThrow) {
                return Promise.reject(new Error("DB connection failed"));
              }
              return Promise.resolve(mockResult);
            }),
          })),
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  verifications: {
    value: "value",
    identifier: "identifier",
    createdAt: "createdAt",
  },
}));

import { GET } from "@/app/api/admin/test/otp/route.staging";

function createRequest(email?: string, token?: string): Request {
  const url = new URL("http://localhost:3000/api/admin/test/otp");
  if (email) {
    url.searchParams.set("email", email);
  }
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request(url.toString(), { headers });
}

describe("GET /api/admin/test/otp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResult = [];
    mockShouldThrow = false;
    process.env.TEST_API_KEY = TEST_KEY;
    process.env.BETTER_AUTH_SECRET = TEST_BETTER_AUTH_SECRET;
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("authentication", () => {
    it("should return 401 when TEST_API_KEY is not configured", async () => {
      // biome-ignore lint/performance/noDelete: delete is required to remove env vars (undefined assignment coerces to string)
      delete process.env.TEST_API_KEY;
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Admin API not configured");
    });

    it("should return 401 when Bearer token is missing", async () => {
      const response = await GET(createRequest(TEST_EMAIL));
      expect(response.status).toBe(401);
    });

    it("should return 401 when Bearer token is wrong", async () => {
      const response = await GET(createRequest(TEST_EMAIL, "wrong-key"));
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Invalid admin API key");
    });
  });

  describe("input validation", () => {
    it("should return 400 when email param is missing", async () => {
      const response = await GET(createRequest(undefined, TEST_KEY));
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Missing email query parameter");
    });

    it("should return 403 for non-techops email", async () => {
      const response = await GET(createRequest("user@gmail.com", TEST_KEY));
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Email must end with @techops.services");
    });
  });

  describe("OTP lookup", () => {
    it("should decrypt and return the plaintext OTP when found", async () => {
      const cipher = await encryptOtp("123456");
      mockResult = [{ value: `${cipher}:2` }];
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.otp).toBe("123456");
    });

    it("should split value on colon and decrypt the first part only", async () => {
      const cipher = await encryptOtp("789012");
      mockResult = [{ value: `${cipher}:5:extra` }];
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.otp).toBe("789012");
    });

    it("should return 404 when no OTP exists", async () => {
      mockResult = [];
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("No OTP found");
    });

    it("should return 404 when value is null", async () => {
      mockResult = [{ value: null }];
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(404);
    });

    it("should return 500 when BETTER_AUTH_SECRET is unset", async () => {
      // biome-ignore lint/performance/noDelete: env var must be removed
      delete process.env.BETTER_AUTH_SECRET;
      mockResult = [{ value: `${await encryptOtp("123456")}:0` }];
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("BETTER_AUTH_SECRET not configured");
    });

    it("should return 500 on database error", async () => {
      mockShouldThrow = true;
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Internal server error");
    });
  });
});
