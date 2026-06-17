import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE_NAME = "pending_scan";
const MAX_SCAN_INTENT_LENGTH = 2048;

/**
 * POST /api/auth/scan-intent
 * Body: { intent: string } — JSON-serialised SuggestionDescriptor + mode + address.
 *
 * Sets a short-lived pending_scan HttpOnly cookie that survives the OAuth
 * round-trip. Mirrors app/api/auth/template-intent/route.ts exactly.
 * FUNNEL-02 / 54-02.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const intent =
    body && typeof body === "object" && "intent" in body
      ? (body as { intent: unknown }).intent
      : undefined;

  if (typeof intent !== "string" || intent.length === 0) {
    return NextResponse.json({ error: "intent is required" }, { status: 400 });
  }

  if (intent.length > MAX_SCAN_INTENT_LENGTH) {
    return NextResponse.json({ error: "intent too long" }, { status: 400 });
  }

  try {
    JSON.parse(intent);
  } catch {
    return NextResponse.json(
      { error: "intent must be valid JSON" },
      { status: 400 }
    );
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: COOKIE_NAME,
    value: intent,
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    maxAge: 600, // 10 minutes — matches template-intent (FUNNEL-02)
  });

  return NextResponse.json({ ok: true });
}

/**
 * GET /api/auth/scan-intent
 *
 * Returns { intent: ScanIntent | null } and atomically clears the cookie
 * (maxAge=0). Mirrors template-intent GET. FUNNEL-02 / 54-02.
 */
export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME);
  const raw = existing?.value ?? null;

  if (existing) {
    cookieStore.set({
      name: COOKIE_NAME,
      value: "",
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 0,
    });
  }

  if (!raw) {
    return NextResponse.json({ intent: null });
  }

  try {
    const intent = JSON.parse(raw) as unknown;
    return NextResponse.json({ intent });
  } catch {
    return NextResponse.json({ intent: null });
  }
}
