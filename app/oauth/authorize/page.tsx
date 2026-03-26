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
  await storeAuthCode({
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
      <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-sm rounded-xl border bg-background px-4 shadow-2xl ring-1 ring-black/5">
          <div className="flex flex-col gap-1.5 p-6 pb-0">
            <h2 className="font-semibold text-lg leading-none tracking-tight">
              Invalid Request
            </h2>
            <p className="text-muted-foreground text-sm">
              Missing required OAuth parameters: client_id and redirect_uri are
              required.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const client = await getOAuthClient(clientId);
  if (!client) {
    return (
      <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-sm rounded-xl border bg-background px-4 shadow-2xl ring-1 ring-black/5">
          <div className="flex flex-col gap-1.5 p-6 pb-0">
            <h2 className="font-semibold text-lg leading-none tracking-tight">
              Unknown Client
            </h2>
            <p className="text-muted-foreground text-sm">
              The application requesting access is not registered.
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (!client.redirectUris.includes(redirectUri)) {
    return (
      <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-sm rounded-xl border bg-background px-4 shadow-2xl ring-1 ring-black/5">
          <div className="flex flex-col gap-1.5 p-6 pb-0">
            <h2 className="font-semibold text-lg leading-none tracking-tight">
              Invalid Redirect URI
            </h2>
            <p className="text-muted-foreground text-sm">
              The redirect URI does not match the registered client.
            </p>
          </div>
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

  const resolvedScope = scope ?? "mcp:read mcp:write";
  const scopeList = parseScopes(resolvedScope);

  const scopeDescriptions: Record<string, string> = {
    "mcp:read": "Read your workflows, executions, and plugin schemas",
    "mcp:write": "Write your workflows, executions, and integrations",
    "mcp:admin": "Full access to your KeeperHub organization",
  };

  return (
    <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex w-full max-w-lg flex-col rounded-xl border bg-background shadow-2xl ring-1 ring-black/5">
        {/* Header */}
        <div className="relative flex flex-col gap-2 p-8 pb-0">
          <h2 className="font-semibold text-lg leading-none tracking-tight">
            Authorize Access
          </h2>
          <p className="text-muted-foreground text-sm">
            <span className="font-medium text-foreground">
              {client.clientName}
            </span>{" "}
            is requesting access to your account.
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8">
          <div className="rounded-lg border bg-muted/30 p-5">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Permissions
            </p>
            <ul className="space-y-3">
              {scopeList.map((s) => (
                <li
                  className="flex items-center gap-3 text-sm text-foreground"
                  key={s}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ds-green-accent-10)]">
                    <svg
                      className="h-3 w-3 text-[var(--ds-green-accent)]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      viewBox="0 0 24 24"
                    >
                      <title>Included</title>
                      <path
                        d="M5 12l5 5L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  {scopeDescriptions[s] ?? s}
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-5 text-sm text-muted-foreground">
            Signed in as{" "}
            <span className="font-medium text-foreground">
              {session.user.email}
            </span>
          </p>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-8 pt-4 sm:justify-end">
          <form action={handleDeny}>
            <input name="client_id" type="hidden" value={clientId} />
            <input name="redirect_uri" type="hidden" value={redirectUri} />
            {state && <input name="state" type="hidden" value={state} />}
            <button
              className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-5 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              type="submit"
            >
              Deny
            </button>
          </form>

          <form action={handleApprove}>
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
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
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
