import { createHash, randomBytes } from "node:crypto";
import { normalizeScope } from "@/lib/mcp/oauth-scopes";
import { type OAuthClient, storeOAuthClient } from "@/lib/mcp/oauth-store";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";

export const dynamic = "force-dynamic";

type RegistrationRequestBody = {
  client_name?: unknown;
  redirect_uris?: unknown;
  scope?: unknown;
  grant_types?: unknown;
};

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const rateLimit = checkIpRateLimit(ip, 10, 60_000);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfter) },
      }
    );
  }

  let body: RegistrationRequestBody;
  try {
    body = (await request.json()) as RegistrationRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { client_name, redirect_uris, scope, grant_types } = body;

  if (typeof client_name !== "string" || client_name.trim().length === 0) {
    return Response.json(
      { error: "client_name is required and must be a string" },
      { status: 400 }
    );
  }

  if (!isStringArray(redirect_uris) || redirect_uris.length === 0) {
    return Response.json(
      {
        error:
          "redirect_uris is required and must be a non-empty array of strings",
      },
      { status: 400 }
    );
  }

  for (const uri of redirect_uris) {
    try {
      new URL(uri);
    } catch {
      return Response.json(
        { error: `Invalid redirect_uri: ${uri}` },
        { status: 400 }
      );
    }
  }

  const resolvedScope = normalizeScope(
    typeof scope === "string" ? scope : "mcp:read"
  );

  const resolvedGrantTypes = isStringArray(grant_types)
    ? grant_types.filter((g) =>
        ["authorization_code", "refresh_token"].includes(g)
      )
    : ["authorization_code", "refresh_token"];

  if (resolvedGrantTypes.length === 0) {
    resolvedGrantTypes.push("authorization_code", "refresh_token");
  }

  const clientId = crypto.randomUUID();
  const clientSecretRaw = randomBytes(32).toString("hex");
  const clientSecretHash = createHash("sha256")
    .update(clientSecretRaw)
    .digest("hex");

  const client: OAuthClient = {
    clientId,
    clientSecretHash,
    clientName: client_name.trim(),
    redirectUris: redirect_uris,
    scopes: resolvedScope.split(" "),
    grantTypes: resolvedGrantTypes,
    organizationId: null,
    createdAt: Date.now(),
  };

  await storeOAuthClient(client);

  return Response.json(
    {
      client_id: clientId,
      client_secret: clientSecretRaw,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      scope: resolvedScope,
    },
    { status: 201 }
  );
}
