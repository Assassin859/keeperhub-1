import { withX402 } from "@x402/next";
import { Challenge, Credential, Expires } from "mppx";
import { type NextRequest, NextResponse } from "next/server";
import { extractMppPayerAddress, hashMppCredential } from "@/lib/mpp/server";
import {
  buildPaymentConfig,
  extractPayerAddress,
  findExistingPayment,
  hashPaymentSignature,
} from "@/lib/x402/payment-gate";
import {
  isTimeoutError,
  pollForPaymentConfirmation,
} from "@/lib/x402/reconcile";
import { server } from "@/lib/x402/server";
import type { CallRouteWorkflow } from "@/lib/x402/types";

export type PaymentProtocol = "x402" | "mpp";

const TEMPO_USDC_ADDRESS = "0x20c000000000000000000000b9537d11c60e8b50";
const TEMPO_CHAIN_ID = 4217;
const USDC_DECIMALS = 6;
const RE_PROTOCOL = /^https?:\/\//;
const RE_TRAILING_SLASH = /\/$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, PAYMENT-SIGNATURE",
  "Access-Control-Expose-Headers": "Payment-Receipt",
} as const;

type Dual402Params = {
  price: string;
  creatorWalletAddress: string;
  workflowName: string;
};

export function buildDual402Response(params: Dual402Params): Response {
  const { price, creatorWalletAddress, workflowName } = params;

  const x402Requirements = {
    accepts: {
      scheme: "exact",
      network: "eip155:8453",
      payTo: creatorWalletAddress,
      price: `$${Number(price).toFixed(2)}`,
    },
    description: `Pay to run workflow: ${workflowName}`,
  };

  const x402Header = Buffer.from(JSON.stringify(x402Requirements)).toString(
    "base64"
  );

  const headers = new Headers(CORS_HEADERS);
  headers.set("X-PAYMENT-REQUIREMENTS", x402Header);
  headers.set("Cache-Control", "no-store");

  const mppSecretKey = process.env.MPP_SECRET_KEY;
  if (mppSecretKey) {
    const realm = (process.env.NEXT_PUBLIC_APP_URL ?? "app.keeperhub.com")
      .replace(RE_PROTOCOL, "")
      .replace(RE_TRAILING_SLASH, "");
    const amountSmallestUnit = String(
      Math.round(Number(price) * 10 ** USDC_DECIMALS)
    );
    const challenge = Challenge.from({
      secretKey: mppSecretKey,
      realm,
      method: "tempo",
      intent: "charge",
      expires: Expires.minutes(5),
      request: {
        amount: amountSmallestUnit,
        currency: TEMPO_USDC_ADDRESS,
        recipient: creatorWalletAddress,
        methodDetails: {
          chainId: TEMPO_CHAIN_ID,
        },
      },
    });
    headers.set("WWW-Authenticate", Challenge.serialize(challenge));
  }

  return new Response(
    JSON.stringify({
      error: "Payment Required",
      x402: x402Requirements,
    }),
    { status: 402, headers }
  );
}

export type PaymentMeta = {
  protocol: PaymentProtocol;
  chain: "base" | "tempo";
  payerAddress: string | null;
};

export function detectProtocol(
  request: Request
): PaymentProtocol | "error" | null {
  const hasAuthorization = request.headers
    .get("authorization")
    ?.startsWith("Payment ");
  const hasPaymentSig = Boolean(request.headers.get("PAYMENT-SIGNATURE"));

  if (hasAuthorization && hasPaymentSig) {
    return "error";
  }
  if (hasAuthorization) {
    return "mpp";
  }
  if (hasPaymentSig) {
    return "x402";
  }
  return null;
}

type HandlerFactory = (
  meta: PaymentMeta
) => (req: NextRequest) => Promise<NextResponse>;

async function checkIdempotency(
  paymentHash: string
): Promise<NextResponse | null> {
  const existing = await findExistingPayment(paymentHash);
  if (existing) {
    return NextResponse.json(
      { executionId: existing.executionId },
      { headers: CORS_HEADERS }
    );
  }
  return null;
}

async function handleX402(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: HandlerFactory
): Promise<NextResponse> {
  const paymentSig = request.headers.get("PAYMENT-SIGNATURE");
  if (paymentSig) {
    const hash = hashPaymentSignature(paymentSig);
    const idempotent = await checkIdempotency(hash);
    if (idempotent) {
      return idempotent;
    }
  }

  const payerAddress = extractPayerAddress(paymentSig);
  const paymentConfig = buildPaymentConfig(workflow, creatorWalletAddress);

  const innerHandler = createHandler({
    protocol: "x402",
    chain: "base",
    payerAddress,
  });

  const gatedHandler = withX402(innerHandler, paymentConfig, server);

  try {
    return (await gatedHandler(request as NextRequest)) as NextResponse;
  } catch (gateErr) {
    const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
    if (isTimeoutError(msg)) {
      const pAddr = request.headers.get("X-PAYER-ADDRESS");
      const nonce = request.headers.get("X-PAYMENT-NONCE");
      if (pAddr && nonce) {
        const confirmed = await pollForPaymentConfirmation({
          payerAddress: pAddr,
          nonce,
        });
        if (confirmed) {
          if (paymentSig) {
            const hash = hashPaymentSignature(paymentSig);
            const idempotent = await checkIdempotency(hash);
            if (idempotent) {
              return idempotent;
            }
          }
          return innerHandler(request as NextRequest);
        }
      }
    }
    throw gateErr;
  }
}

async function handleMpp(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: HandlerFactory
): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const credentialValue = authHeader.slice("Payment ".length);
    const hash = hashMppCredential(credentialValue);
    const idempotent = await checkIdempotency(hash);
    if (idempotent) {
      return idempotent;
    }
  }

  // Dynamic import to avoid loading mppx when not needed
  const { getMppServer } = await import("@/lib/mpp/server");
  type ChargeResult =
    | { status: 402; challenge: Response; withReceipt?: never }
    | {
        status: 200;
        challenge?: never;
        withReceipt: (response: Response) => Response;
      };
  const mppServer = (await getMppServer()) as {
    charge: (opts: {
      amount: string;
      recipient: string;
    }) => (request: Request) => Promise<ChargeResult>;
  };

  const price = workflow.priceUsdcPerCall ?? "0";
  const chargeIntent = mppServer.charge({
    amount: price,
    recipient: creatorWalletAddress,
  });

  const result = await chargeIntent(request);

  if (result.status === 402) {
    const challenge = result.challenge as unknown as NextResponse;
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      challenge.headers.set(key, value);
    }
    return challenge;
  }

  let credentialSource: string | null = null;
  try {
    const credential = Credential.fromRequest(request);
    credentialSource = credential.source ?? null;
  } catch {
    // credential source is optional -- wallets may omit it
  }
  const payerAddress = extractMppPayerAddress(credentialSource);

  const innerHandler = createHandler({
    protocol: "mpp",
    chain: "tempo",
    payerAddress,
  });

  const response = await innerHandler(request as NextRequest);
  return result.withReceipt(response) as unknown as NextResponse;
}

export function gatePayment(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: HandlerFactory
): Promise<NextResponse> {
  const protocol = detectProtocol(request);

  if (protocol === "error") {
    return Promise.resolve(
      NextResponse.json(
        {
          error:
            "Cannot send both PAYMENT-SIGNATURE and Authorization: Payment headers",
        },
        { status: 400, headers: CORS_HEADERS }
      )
    );
  }

  if (protocol === "x402") {
    return handleX402(request, workflow, creatorWalletAddress, createHandler);
  }

  if (protocol === "mpp") {
    return handleMpp(request, workflow, creatorWalletAddress, createHandler);
  }

  // No payment header -- return dual 402 challenge
  return Promise.resolve(
    buildDual402Response({
      price: workflow.priceUsdcPerCall ?? "0",
      creatorWalletAddress,
      workflowName: workflow.name,
    }) as NextResponse
  );
}
