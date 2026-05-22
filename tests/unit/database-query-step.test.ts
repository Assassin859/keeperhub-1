import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-only guard module loads "server-only"; stub it for vitest.
vi.mock("server-only", () => ({}));

// Hoisted mocks shared by the vi.mock factories below.
const { mockFetchCredentials, mockPostgres, mockLookup, mockWithStepLogging } =
  vi.hoisted(() => ({
    mockFetchCredentials: vi.fn(),
    mockPostgres: vi.fn(),
    mockLookup: vi.fn(),
    mockWithStepLogging: vi.fn(
      (_input: unknown, fn: () => unknown) => fn() as unknown
    ),
  }));

vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) =>
    mockFetchCredentials(...(args as [string])),
}));

vi.mock("postgres", () => ({
  default: (...args: unknown[]) => mockPostgres(...args),
}));

vi.mock("node:dns", () => ({
  promises: { lookup: mockLookup },
}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (...args: unknown[]) =>
    mockWithStepLogging(...(args as [unknown, () => unknown])),
}));

import {
  type DatabaseQueryInput,
  databaseQueryStep,
} from "@/lib/workflow/nodes/database-query/step";

const STEP_INPUT_BASE: DatabaseQueryInput = {
  integrationId: "integration-1",
  dbQuery: "SELECT 1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("databaseQueryStep guard wiring", () => {
  it.each([
    ["IPv4 IMDS link-local", "postgres://u:p@169.254.169.254:5432/db"],
    ["IPv4 private 10/8", "postgres://u:p@10.0.0.5:5432/db"],
    ["IPv4 loopback", "postgres://u:p@127.0.0.1:5432/db"],
    ["IPv6 loopback bracketed", "postgres://u:p@[::1]:5432/db"],
    ["IPv6 ULA bracketed", "postgres://u:p@[fc00::1]:5432/db"],
  ])("rejects %s before opening a socket", async (_label, url) => {
    mockFetchCredentials.mockResolvedValue({ DATABASE_URL: url });

    const result = (await databaseQueryStep(STEP_INPUT_BASE)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockPostgres).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    ["localhost", "postgres://u:p@localhost:5432/db"],
    [
      "k8s service DNS",
      "postgres://u:p@db.keeperhub.svc.cluster.local:5432/db",
    ],
    [
      "EC2 internal hostname",
      "postgres://u:p@ip-10-0-0-5.us-east-2.compute.internal:5432/db",
    ],
    ["mDNS suffix", "postgres://u:p@db.local:5432/db"],
  ])("rejects hostname pattern %s before any DNS lookup or socket", async (_label, url) => {
    mockFetchCredentials.mockResolvedValue({ DATABASE_URL: url });

    const result = (await databaseQueryStep(STEP_INPUT_BASE)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockPostgres).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects hostname that resolves to a private address", async () => {
    mockFetchCredentials.mockResolvedValue({
      DATABASE_URL: "postgres://u:p@db.example:5432/db",
    });
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const result = (await databaseQueryStep(STEP_INPUT_BASE)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).toHaveBeenCalled();
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it("does not leak the connection string in the error", async () => {
    const url =
      "postgres://supersecretuser:supersecretpassword@10.0.0.1:5432/internal";
    mockFetchCredentials.mockResolvedValue({ DATABASE_URL: url });

    const result = (await databaseQueryStep(STEP_INPUT_BASE)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    const error = result.error ?? "";
    expect(error).not.toContain("supersecret");
    expect(error).not.toContain("10.0.0.1");
    expect(error).not.toContain("internal");
  });
});
