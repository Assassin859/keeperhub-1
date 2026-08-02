import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@turnkey/crypto", () => ({
  generateP256KeyPair: vi.fn(() => ({
    publicKeyUncompressed: "mock-public-key",
    privateKey: "mock-private-key",
  })),
  decryptExportBundle: vi.fn(),
}));

const mockExportWalletAccount = vi.fn();
const mockApiClient = vi.fn(() => ({
  exportWalletAccount: mockExportWalletAccount,
}));

vi.mock("@turnkey/sdk-server", () => ({
  Turnkey: vi.fn(function MockTurnkey() {
    return {
      apiClient: mockApiClient,
    };
  }),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "external_service" },
  logSystemError: vi.fn(),
}));

describe("exportTurnkeyPrivateKey", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.TURNKEY_API_PUBLIC_KEY = "pub";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv";
    process.env.TURNKEY_ORGANIZATION_ID = "org-root";
  });

  it("exports EVM keys with a 0x prefix", async () => {
    const { decryptExportBundle } = await import("@turnkey/crypto");
    vi.mocked(decryptExportBundle).mockResolvedValue("abc123");
    mockExportWalletAccount.mockResolvedValue({
      exportBundle: "bundle",
    });

    const { exportTurnkeyPrivateKey } = await import(
      "@/lib/turnkey/turnkey-operations"
    );

    const result = await exportTurnkeyPrivateKey(
      "sub-org",
      "0xAbC12345678901234567890123456789012345678",
      "evm"
    );

    expect(result).toBe("0xabc123");
    expect(mockExportWalletAccount).toHaveBeenCalledWith({
      organizationId: "sub-org",
      address: "0xAbC12345678901234567890123456789012345678",
      targetPublicKey: "mock-public-key",
    });
  });

  it("exports Solana keys as hex without a 0x prefix", async () => {
    const { decryptExportBundle } = await import("@turnkey/crypto");
    vi.mocked(decryptExportBundle).mockResolvedValue("0xdeadbeef");
    mockExportWalletAccount.mockResolvedValue({
      exportBundle: "bundle",
    });

    const { exportTurnkeyPrivateKey } = await import(
      "@/lib/turnkey/turnkey-operations"
    );

    const result = await exportTurnkeyPrivateKey(
      "sub-org",
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "solana"
    );

    expect(result).toBe("deadbeef");
    expect(mockExportWalletAccount).toHaveBeenCalledWith({
      organizationId: "sub-org",
      address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      targetPublicKey: "mock-public-key",
    });
  });
});
