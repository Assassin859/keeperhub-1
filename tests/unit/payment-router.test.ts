import { describe, expect, it, vi } from "vitest";

vi.mock("@x402/next", () => ({ withX402: vi.fn() }));
vi.mock("@/lib/x402/payment-gate", () => ({
  buildPaymentConfig: vi.fn(),
  extractPayerAddress: vi.fn(),
  findExistingPayment: vi.fn(),
  hashPaymentSignature: vi.fn(),
}));
vi.mock("@/lib/x402/server", () => ({ server: {} }));
vi.mock("@/lib/x402/reconcile", () => ({
  isTimeoutError: vi.fn(),
  pollForPaymentConfirmation: vi.fn(),
}));
vi.mock("@/lib/mpp/server", () => ({
  extractMppPayerAddress: vi.fn(),
  hashMppCredential: vi.fn(),
  getMppServer: vi.fn(),
}));

vi.mock("mppx", () => ({
  Challenge: {
    from: vi.fn().mockReturnValue({
      id: "test-id",
      realm: "test",
      method: "tempo",
      intent: "charge",
      expires: "2099-01-01T00:00:00.000Z",
      request: {},
    }),
    serialize: vi
      .fn()
      .mockReturnValue(
        'Payment id="test-id", realm="test", method="tempo", intent="charge", request="eyJ9"'
      ),
  },
  Credential: {
    fromRequest: vi.fn().mockReturnValue({ source: null }),
  },
  Expires: {
    minutes: vi.fn().mockReturnValue("2099-01-01T00:00:00.000Z"),
  },
}));

import { Challenge, Expires } from "mppx";
import { buildDual402Response, detectProtocol } from "@/lib/payments/router";

describe("detectProtocol", () => {
  it("returns 'mpp' when Authorization: Payment header is present", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Payment eyJjaGFsbGVuZ2UiOnt9fQ" },
    });
    expect(detectProtocol(req)).toBe("mpp");
  });

  it("returns 'x402' when PAYMENT-SIGNATURE header is present", () => {
    const req = new Request("http://localhost", {
      headers: { "PAYMENT-SIGNATURE": "base64sig" },
    });
    expect(detectProtocol(req)).toBe("x402");
  });

  it("returns null when no payment headers are present", () => {
    const req = new Request("http://localhost");
    expect(detectProtocol(req)).toBeNull();
  });

  it("returns 'error' when both headers are present", () => {
    const req = new Request("http://localhost", {
      headers: {
        Authorization: "Payment eyJ...",
        "PAYMENT-SIGNATURE": "base64sig",
      },
    });
    expect(detectProtocol(req)).toBe("error");
  });

  it("ignores Authorization headers that are not Payment scheme", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer token123" },
    });
    expect(detectProtocol(req)).toBeNull();
  });
});

describe("buildDual402Response", () => {
  it("returns a 402 response", () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
    });
    expect(response.status).toBe(402);
  });

  it("includes CORS headers", () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("includes WWW-Authenticate header when MPP_SECRET_KEY is set", () => {
    process.env.MPP_SECRET_KEY = "test-secret";
    try {
      const response = buildDual402Response({
        price: "0.01",
        creatorWalletAddress: "0xCreator",
        workflowName: "Test Workflow",
      });
      const wwwAuth = response.headers.get("WWW-Authenticate");
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain("Payment");
      expect(wwwAuth).toContain("tempo");
      expect(wwwAuth).toContain("charge");
    } finally {
      delete process.env.MPP_SECRET_KEY;
    }
  });

  it("passes expires to Challenge.from", () => {
    process.env.MPP_SECRET_KEY = "test-secret";
    try {
      buildDual402Response({
        price: "0.01",
        creatorWalletAddress: "0xCreator",
        workflowName: "Test Workflow",
      });
      expect(Expires.minutes).toHaveBeenCalledWith(5);
      expect(Challenge.from).toHaveBeenCalledWith(
        expect.objectContaining({
          expires: "2099-01-01T00:00:00.000Z",
        })
      );
    } finally {
      delete process.env.MPP_SECRET_KEY;
    }
  });

  it("passes methodDetails.chainId to Challenge.from for Tempo pinned-field parity", () => {
    process.env.MPP_SECRET_KEY = "test-secret";
    try {
      buildDual402Response({
        price: "0.01",
        creatorWalletAddress: "0xCreator",
        workflowName: "Test Workflow",
      });
      expect(Challenge.from).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            amount: "10000",
            methodDetails: { chainId: 4217 },
          }),
        })
      );
    } finally {
      delete process.env.MPP_SECRET_KEY;
    }
  });

  it("omits WWW-Authenticate header when MPP_SECRET_KEY is not set", () => {
    delete process.env.MPP_SECRET_KEY;
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
    });
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
  });
});
