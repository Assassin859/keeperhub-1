import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-1";
const USER_EMAIL = "user@example.com";
const CREDENTIAL_ACCOUNT_ID = "acct-credential";
const VERIFICATION_ID = "verification-1";
const VALID_OTP = "123456";

const {
  mockVerificationsFindFirst,
  mockUsersFindFirst,
  mockAccountsFindFirst,
  mockTransaction,
  mockHashPassword,
  mockSymmetricDecrypt,
  mockSymmetricEncrypt,
  mockEq,
  mockAnd,
  mockGt,
  txUpdateCalls,
  txDeleteCalls,
} = vi.hoisted(() => ({
  mockVerificationsFindFirst: vi.fn(),
  mockUsersFindFirst: vi.fn(),
  mockAccountsFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockHashPassword: vi.fn(),
  mockSymmetricDecrypt: vi.fn(),
  mockSymmetricEncrypt: vi.fn(),
  mockEq: vi.fn((column: unknown, value: unknown) => ({
    __eq: [column, value],
  })),
  mockAnd: vi.fn((...args: unknown[]) => ({ __and: args })),
  mockGt: vi.fn((column: unknown, value: unknown) => ({
    __gt: [column, value],
  })),
  txUpdateCalls: [] as Array<{ table: unknown; value: unknown }>,
  txDeleteCalls: [] as Array<{ table: unknown }>,
}));

vi.mock("drizzle-orm", () => ({
  and: mockAnd,
  eq: mockEq,
  gt: mockGt,
}));

vi.mock("better-auth/crypto", () => ({
  symmetricDecrypt: mockSymmetricDecrypt,
  symmetricEncrypt: mockSymmetricEncrypt,
}));

const txStub = {
  update: vi.fn((table: unknown) => ({
    set: vi.fn((value: unknown) => {
      txUpdateCalls.push({ table, value });
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  })),
  delete: vi.fn((table: unknown) => {
    txDeleteCalls.push({ table });
    return { where: vi.fn().mockResolvedValue(undefined) };
  }),
};

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      verifications: { findFirst: mockVerificationsFindFirst },
      users: { findFirst: mockUsersFindFirst },
      accounts: { findFirst: mockAccountsFindFirst },
    },
    transaction: mockTransaction,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  accounts: {
    id: "accounts.id",
    userId: "accounts.userId",
    providerId: "accounts.providerId",
  },
  sessions: { id: "sessions.id", userId: "sessions.userId" },
  twoFactor: { userId: "twoFactor.userId", secret: "twoFactor.secret" },
  users: { id: "users.id", email: "users.email" },
  verifications: {
    id: "verifications.id",
    identifier: "verifications.identifier",
    expiresAt: "verifications.expiresAt",
  },
}));

vi.mock("@/lib/email", () => ({
  sendOAuthPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationOTP: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH", CONFIGURATION: "CONFIGURATION" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/password", () => ({
  hashPassword: mockHashPassword,
}));

vi.mock("@/lib/security/totp-verify", () => ({
  verifyUserTotp: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/security/trusted-proxies", () => ({
  resolveTrustedClientIp: vi.fn(() => "203.0.113.10"),
}));

vi.mock("@/lib/utils/id", () => ({
  generateId: vi.fn(() => "generated-id"),
}));

import { POST } from "@/app/api/user/forgot-password/route";
import { sessions as sessionsToken } from "@/lib/db/schema";

function buildResetRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  txUpdateCalls.length = 0;
  txDeleteCalls.length = 0;
  process.env.BETTER_AUTH_SECRET = "test-secret";
  mockHashPassword.mockResolvedValue("new-stored-hash");
  mockSymmetricDecrypt.mockResolvedValue(VALID_OTP);
  mockTransaction.mockImplementation(
    async (cb: (tx: typeof txStub) => Promise<unknown>) => {
      await cb(txStub);
    }
  );
});

describe("POST /api/user/forgot-password (reset)", () => {
  it("deletes all of the user's sessions after a successful reset", async () => {
    mockVerificationsFindFirst.mockResolvedValue({
      id: VERIFICATION_ID,
      value: "ciphertext:0",
    });
    mockUsersFindFirst.mockResolvedValue({
      id: USER_ID,
      email: USER_EMAIL,
      twoFactorEnabled: false,
    });
    mockAccountsFindFirst.mockResolvedValue({ id: CREDENTIAL_ACCOUNT_ID });

    const response = await POST(
      buildResetRequest({
        action: "reset",
        email: USER_EMAIL,
        otp: VALID_OTP,
        newPassword: "new-password-1",
      })
    );

    expect(response.status).toBe(200);

    // Transaction performed the account update plus two deletes
    // (consumed verification row + every session for the user).
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(txUpdateCalls).toHaveLength(1);
    expect(txDeleteCalls).toHaveLength(2);
    expect(txDeleteCalls.some((call) => call.table === sessionsToken)).toBe(
      true
    );
    expect(mockEq).toHaveBeenCalledWith("sessions.userId", USER_ID);
  });

  it("does not touch sessions when the OTP is invalid or expired", async () => {
    mockVerificationsFindFirst.mockResolvedValue(undefined);

    const response = await POST(
      buildResetRequest({
        action: "reset",
        email: USER_EMAIL,
        otp: "000000",
        newPassword: "new-password-1",
      })
    );

    expect(response.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(txDeleteCalls).toHaveLength(0);
  });
});
