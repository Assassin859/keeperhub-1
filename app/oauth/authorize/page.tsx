import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { parseScopes } from "@/lib/mcp/oauth-scopes";
import {
  AUTH_CODE_TTL_MS,
  getOAuthClient,
  storeAuthCode,
} from "@/lib/mcp/oauth-store";
import { getOrgContext } from "@/lib/middleware/org-context";

type AuthorizeSearchParams = {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
};

type PageProps = {
  searchParams: Promise<AuthorizeSearchParams>;
};

function errorRedirect(
  redirectUri: string,
  error: string,
  state: string | undefined
): never {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) {
    url.searchParams.set("state", state);
  }
  redirect(url.toString());
}

async function handleApprove(formData: FormData): Promise<void> {
  "use server";
  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const scope = formData.get("scope") as string;
  const state = formData.get("state") as string | null;
  const codeChallenge = formData.get("code_challenge") as string;
  const codeChallengeMethod = formData.get("code_challenge_method") as string;

  const client = await getOAuthClient(clientId);
  if (!client?.redirectUris.includes(redirectUri)) {
    redirect("/oauth/authorize?error=invalid_request");
  }

  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    redirect(`/?returnTo=${encodeURIComponent("/oauth/authorize")}`);
  }

  const orgContext = await getOrgContext();
  const organizationId = orgContext.organization?.id ?? session.user.id;

  const code = crypto.randomUUID().replace(/-/g, "");
  storeAuthCode({
    code,
    clientId,
    redirectUri,
    scope,
    userId: session.user.id,
    organizationId,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (state) {
    callbackUrl.searchParams.set("state", state);
  }
  redirect(callbackUrl.toString());
}

async function handleDeny(formData: FormData): Promise<void> {
  "use server";
  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const state = formData.get("state") as string | null;

  const client = await getOAuthClient(clientId);
  if (!client?.redirectUris.includes(redirectUri)) {
    redirect("/oauth/authorize?error=invalid_request");
  }

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("error", "access_denied");
  if (state) {
    callbackUrl.searchParams.set("state", state);
  }
  redirect(callbackUrl.toString());
}

export default async function AuthorizePage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: responseType,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  } = params;

  // Validate required parameters before doing anything else
  if (!(clientId && redirectUri)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-8">
          <h1 className="mb-2 text-xl font-semibold text-foreground">
            Invalid Request
          </h1>
          <p className="text-muted-foreground">
            Missing required OAuth parameters: client_id and redirect_uri are
            required.
          </p>
        </div>
      </main>
    );
  }

  const client = await getOAuthClient(clientId);
  if (!client) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-8">
          <h1 className="mb-2 text-xl font-semibold text-foreground">
            Unknown Client
          </h1>
          <p className="text-muted-foreground">
            The application requesting access is not registered.
          </p>
        </div>
      </main>
    );
  }

  if (!client.redirectUris.includes(redirectUri)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-8">
          <h1 className="mb-2 text-xl font-semibold text-foreground">
            Invalid Redirect URI
          </h1>
          <p className="text-muted-foreground">
            The redirect URI does not match the registered client.
          </p>
        </div>
      </main>
    );
  }

  if (responseType !== "code") {
    errorRedirect(redirectUri, "unsupported_response_type", state);
  }

  if (!codeChallenge || codeChallengeMethod !== "S256") {
    errorRedirect(redirectUri, "invalid_request", state);
  }

  // Check if user is authenticated
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    const loginUrl = new URL(
      "/",
      requestHeaders.get("x-forwarded-proto")
        ? `${requestHeaders.get("x-forwarded-proto")}://${requestHeaders.get("host")}`
        : "http://localhost:3000"
    );
    const returnTo = new URL(
      `/oauth/authorize?${new URLSearchParams(params as Record<string, string>).toString()}`,
      loginUrl
    );
    redirect(
      `/?returnTo=${encodeURIComponent(returnTo.pathname + returnTo.search)}`
    );
  }

  const resolvedScope = scope ?? "mcp:read";
  const scopeList = parseScopes(resolvedScope);

  const scopeDescriptions: Record<string, string> = {
    "mcp:read": "Read your workflows, executions, and plugin schemas",
    "mcp:write":
      "Read and write access to your workflows, executions, and integrations",
    "mcp:admin": "Full access to your KeeperHub organization",
  };

  return (
    <main className="pointer-events-auto flex min-h-screen items-center justify-center overflow-y-auto bg-background">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-foreground">
          Authorize Access
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {client.clientName}
          </span>{" "}
          is requesting access to your KeeperHub account.
        </p>

        <div className="mb-6 rounded-md border border-border bg-muted/50 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Requested permissions
          </p>
          <ul className="space-y-1">
            {scopeList.map((s) => (
              <li className="text-sm text-foreground" key={s}>
                {scopeDescriptions[s] ?? s}
              </li>
            ))}
          </ul>
        </div>

        <p className="mb-6 text-xs text-muted-foreground">
          Signed in as{" "}
          <span className="font-medium text-foreground">
            {session.user.email}
          </span>
        </p>

        <div className="flex gap-3">
          <form action={handleDeny} className="flex-1">
            <input name="client_id" type="hidden" value={clientId} />
            <input name="redirect_uri" type="hidden" value={redirectUri} />
            {state && <input name="state" type="hidden" value={state} />}
            <button
              className="w-full rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
              type="submit"
            >
              Deny
            </button>
          </form>

          <form action={handleApprove} className="flex-1">
            <input name="client_id" type="hidden" value={clientId} />
            <input name="redirect_uri" type="hidden" value={redirectUri} />
            <input name="scope" type="hidden" value={resolvedScope} />
            {state && <input name="state" type="hidden" value={state} />}
            <input name="code_challenge" type="hidden" value={codeChallenge} />
            <input
              name="code_challenge_method"
              type="hidden"
              value={codeChallengeMethod}
            />
            <button
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              type="submit"
            >
              Approve
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
