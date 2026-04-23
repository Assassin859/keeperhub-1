import { createHash, randomBytes } from "node:crypto";
import { normalizeScope } from "@/lib/mcp/oauth-scopes";
import { type OAuthClient, storeOAuthClient } from "@/lib/mcp/oauth-store";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";

export const dynamic = "force-dynamic";

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

type RegistrationRequestBody = {
  client_name?: unknown;
  redirect_uris?: unknown;
  scope?: unknown;
  grant_types?: unknown;
  token_endpoint_auth_method?: unknown;
};

type TokenEndpointAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

const SUPPORTED_AUTH_METHODS: ReadonlyArray<TokenEndpointAuthMethod> = [
  "client_secret_basic",
  "client_secret_post",
  "none",
];

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function resolveAuthMethod(value: unknown): TokenEndpointAuthMethod {
  if (typeof value === "string") {
    const match = SUPPORTED_AUTH_METHODS.find((m) => m === value);
    if (match) {
      return match;
    }
  }
  return "client_secret_post";
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

  const {
    client_name,
    redirect_uris,
    scope,
    grant_types,
    token_endpoint_auth_method,
  } = body;
  const authMethod = resolveAuthMethod(token_endpoint_auth_method);

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

  // Public clients (RFC 8252 native apps) register with
  // `token_endpoint_auth_method: "none"` and rely on PKCE. Returning a
  // client_secret in that case contradicts what the client asked for and
  // causes strict MCP hosts (e.g. Claude Desktop's connector validator) to
  // reject the registration. Store a secret hash either way so the schema
  // stays stable, but only expose it for confidential-client registrations.
  const baseUrl = deriveBaseUrl(request);
  const responseBase = {
    client_id: clientId,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    scope: resolvedScope,
    // RFC 7591 §3.2.1 management endpoint. Linear/Notion return this; some
    // strict validators treat its absence as an incomplete registration.
    registration_client_uri: `${baseUrl}/api/oauth/register/${clientId}`,
  };
  const responseBody =
    authMethod === "none"
      ? responseBase
      : { ...responseBase, client_secret: clientSecretRaw };

  return Response.json(responseBody, { status: 201 });
}
