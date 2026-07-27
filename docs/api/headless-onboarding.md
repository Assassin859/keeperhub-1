---
title: "Headless and Agent Onboarding"
description: "Zero to a first executed transaction without a browser - SIWE sign-in, creating an organization API key programmatically, funding the right wallet, and gas."
---

# Headless and Agent Onboarding

The dashboard flow assumes a browser: a captcha on sign-up, a wallet extension
for confirmations. Agents, CI jobs and scripts have neither. Every step below is
reachable over HTTP with an EOA private key and nothing else.

| Step | Call |
|---|---|
| Sign in | `POST /api/auth/siwe/nonce`, then `POST /api/auth/siwe/verify` |
| Create a key | `POST /api/keys` twice - the first answers with a challenge to sign |
| Find the wallet to fund | `GET /api/user` -> `walletAddress` |
| Execute | `POST /api/execute/transfer` with `simulate: true`, then without |

Two things to know before the first call:

- **Send an `Origin` header.** Better Auth enforces trusted origins, so a request
  without `Origin: https://app.keeperhub.com` is rejected with `403`
  `MISSING_OR_NULL_ORIGIN` before it reaches the route. Browsers set this
  automatically; an HTTP client does not.
- **Session endpoints use cookies.** Keep the `Set-Cookie` values from the SIWE
  verify response and send them back on every subsequent session call.

## 1. Sign in with a wallet, not a password

`POST /api/auth/sign-up/email` is protected by Cloudflare Turnstile in
production. A client that cannot solve the challenge gets `400`:

```json
{ "message": "Missing CAPTCHA response", "code": "MISSING_RESPONSE" }
```

Sign-up is the only captcha-gated route, which is enough to stop a first run:
there is no account yet to sign in to.

Sign in with Ethereum (EIP-4361) is not captcha-gated, and for a wallet that has
never been seen before, signing in *is* signing up:

```ts
const nonce = await post("/api/auth/siwe/nonce", {
  walletAddress: address,
  chainId: 1,
});

const message = [
  "app.keeperhub.com wants you to sign in with your Ethereum account:",
  address,
  "",
  "Sign in to KeeperHub",
  "",
  "URI: https://app.keeperhub.com",
  "Version: 1",
  "Chain ID: 1",
  `Nonce: ${nonce.nonce}`,
  `Issued At: ${new Date().toISOString()}`,
].join("\n");

await post("/api/auth/siwe/verify", {
  message,
  signature: await account.signMessage({ message }),
  walletAddress: address,
  chainId: 1,
});
```

`verify` returns the session and sets the session cookie. The first sign-in also
creates:

- A user whose email is synthetic: `<address>@wallet.keeperhub.com`. It is never
  delivered to, so wallet accounts receive no verification mail and no signup
  notifications.
- An organization with that user as owner, and an organization wallet (step 3).

The `chainId` here is part of the login assertion. It does not constrain which
chain you execute on later: the script at the bottom of this page signs in with
`chainId: 1` and executes on Base.

Rate limits are per IP: 20 nonces and 10 verifies per hour.

## 2. Create an organization API key

`POST /api/keys` requires session authentication - a `kh_` key cannot mint
another key - and it is additionally step-up gated. The first call returns
`401`:

```json
{
  "error": "Confirm this action to continue.",
  "code": "signature_required",
  "challenge": "KeeperHub action confirmation\n\nAction: org_api_key_manage\nNonce: 1a45b746114d0bdf9a5bec04335fd78b",
  "required": ["wallet"]
}
```

Sign `challenge` verbatim with `personal_sign` (EIP-191), using the account you
signed in with, and repeat the request with the signature added to the JSON
body:

```ts
const first = await post("/api/keys", { name: "my-agent" });
// first.code === "signature_required"

const key = await post("/api/keys", {
  name: "my-agent",
  signature: await account.signMessage({ message: first.challenge }),
});
// key.key is the full kh_ key, returned once and never again
```

Details that otherwise cost debugging time:

- The extra fields go in the **request body**, not in headers.
- The nonce is single-use, expires after five minutes, and **a fresh one is
  minted on every `401`**. Sign the challenge from the response you just
  received. A client that caches the first challenge and retries loops forever
  on `wallet_signature_invalid`.
- The signature must come from the login account. Another account of the same
  wallet also returns `wallet_signature_invalid`.
- `required` lists every factor the action needs. A wallet account that has
  additionally enrolled TOTP or a step-up email must satisfy all of them in the
  same retry, as `signature`, `code` (TOTP) and `emailOtp`. When only the
  non-wallet factors are missing the code is `factors_required` rather than
  `signature_required`.

`DELETE /api/keys/{keyId}` is gated by the same `org_api_key_manage` action, so
a headless client has to answer the challenge to clean up after itself too. The
same challenge-and-retry protocol guards the other step-up actions: wallet
withdrawal, private-key export, session revocation, account deactivation, TOTP
removal and audit-log export.

## 3. The wallet to fund is not the wallet you signed in with

Execution is organization-scoped. Transactions are signed by the organization's
wallet, which is provisioned for you and is a **different address** from the one
you authenticated with. Reading it from `GET /api/user` is the fastest way:

```json
{
  "id": "QB3PWiFqBLcr2NmuTHULLllvpwaLaBZM",
  "email": "0x90ee...4ac@wallet.keeperhub.com",
  "providerId": "siwe",
  "walletAddress": "0x0bdf..."
}
```

`walletAddress` on this response is the **active organization's** wallet, not the
caller's login address. See [User API](/api/user).

The other way is to simulate the write you intend and read `from`:

```json
{
  "success": true,
  "status": "simulated",
  "from": "0x0bdf...",
  "to": "0x90ee...",
  "value": "10000000000000",
  "gasEstimate": "21227",
  "wouldRevert": false
}
```

`from` is the address that would sign, so it is the address that has to hold the
funds.

## 4. Gas on the sponsored chains

The [Hackathon Quickstart](/quickstart) says to fund the wallet with native gas
first. On the chains Turnkey's Gas Station covers - Ethereum, Polygon, Base and
Arbitrum, plus Ethereum Sepolia, Polygon Amoy, Base Sepolia and Arbitrum Sepolia
- that is only true of the value the transaction moves. The transaction is
signed and sponsored in a single Turnkey call and broadcast by a relayer that
pays the gas, and the organization wallet is debited only for what it sends.
Measured on Base: a 0.00001 ETH transfer left the organization wallet exactly
0.00001 ETH lighter, with the gas paid by the broadcasting relayer, and a
self-transfer from the same wallet left its balance unchanged to the wei.

Sponsorship is a preflight, not a guarantee. Outside that chain list, or when
the organization's wallet has no Turnkey sub-organization, the runtime falls
back to direct signing and the wallet pays its own gas. A small native balance
is still the safe default.

Two consequences when reading the transaction back:

- The onchain `from` is the relayer, not your wallet, and the top-level
  `to`/`value` belong to the delegation wrapper - the transfer itself appears as
  an internal call. A block explorer's summary line showing `0 ETH` does not
  mean nothing moved. Treat the `transactionHash` and `transactionLink` from
  `GET /api/execute/{executionId}/status` as the authoritative record.
- The organization wallet is an EOA carrying an EIP-7702 delegation. The
  delegation is installed by a type-4 transaction the first time it is needed;
  later writes from the same wallet are ordinary type-2 transactions.

## 5. Simulate, execute, confirm

From here the normal [Direct Execution](/api/direct-execution) rules apply:
simulate with the same body you intend to send, then send it once with an
`Idempotency-Key` so an interrupted client can retry without double-executing,
then poll `GET /api/execute/{executionId}/status`.

## 6. Your first transaction should move zero

A brand-new organization wallet holds nothing, so a first run with a non-zero
`amount` never reaches the chain. It fails inside the simulator as:

```
Simulation reverted: missing revert data (action="estimateGas", data=null,
reason=null, transaction={...}, invocation=null, revert=null,
code=CALL_EXCEPTION, version=6.16.0)
```

That message names neither the balance nor the wallet, so on a first run it
reads as a broken endpoint rather than an empty account - and the obvious next
moves, re-checking the API key or re-reading this page, are all wrong.

Send `amount: "0"` instead. A zero-value self-transfer is a real, mined,
independently verifiable transaction, and because the relayer pays the gas
(section 4) a wallet that has never held a wei can land one. That gets you a
transaction hash on the first attempt, with no faucet and no bridge, and proves
the whole path end to end before any value is at stake.

Once you do move value, read the balance first and say the real reason yourself:

```ts
const balance = await publicClient.getBalance({ address: user.walletAddress });
if (parseEther(amount) > balance) {
  throw new Error(
    `Fund ${user.walletAddress} on chain ${chainId} - it holds ${formatEther(balance)}`,
  );
}
```

## Full script

Signs in, creates a key, finds the organization wallet and executes a transfer.
No browser and no manual step. A runnable version of this path, with the balance
preflight and an onchain verification step that checks the receipt against a
public RPC rather than trusting the API's own `"completed"`, is at
[piiiico/keeperhub-headless-starter](https://github.com/piiiico/keeperhub-headless-starter).

```ts
import { privateKeyToAccount } from "viem/accounts";

const BASE = "https://app.keeperhub.com";
const account = privateKeyToAccount(process.env.ETH_PRIVATE_KEY as `0x${string}`);
const cookies: string[] = [];

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE,
      Cookie: cookies.join("; "),
      ...(init.headers as Record<string, string>),
    },
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    cookies.push(c.split(";")[0]);
  }
  return { status: res.status, body: await res.json() };
}

// 1. Sign in. Creates the account, its organization and the wallet on first use.
const { body: nonce } = await api("/api/auth/siwe/nonce", {
  method: "POST",
  body: JSON.stringify({ walletAddress: account.address, chainId: 1 }),
});
const message = [
  "app.keeperhub.com wants you to sign in with your Ethereum account:",
  account.address,
  "",
  "Sign in to KeeperHub",
  "",
  `URI: ${BASE}`,
  "Version: 1",
  "Chain ID: 1",
  `Nonce: ${nonce.nonce}`,
  `Issued At: ${new Date().toISOString()}`,
].join("\n");
await api("/api/auth/siwe/verify", {
  method: "POST",
  body: JSON.stringify({
    message,
    signature: await account.signMessage({ message }),
    walletAddress: account.address,
    chainId: 1,
  }),
});

// 2. Create an organization API key: the first POST answers with a challenge.
const create = { name: `headless-${Date.now()}` };
const first = await api("/api/keys", {
  method: "POST",
  body: JSON.stringify(create),
});
const { body: key } = await api("/api/keys", {
  method: "POST",
  body: JSON.stringify({
    ...create,
    // Sign the challenge from THIS response: the nonce is single-use and a
    // fresh one is minted on every 401.
    signature: await account.signMessage({ message: first.body.challenge }),
  }),
});
const auth = { Authorization: `Bearer ${key.key}` };

// 3. The wallet that needs funding is the organization wallet.
const { body: user } = await api("/api/user");
console.log("fund this address:", user.walletAddress);

// 4. Simulate, then execute once with an idempotency key.
// amount "0" on purpose: a new organization wallet is empty, and a zero-value
// self-transfer still lands a real, verifiable transaction because the relayer
// pays the gas. Raise it only after the wallet above is funded (section 6).
const transfer = {
  chainId: 8453,
  recipientAddress: user.walletAddress,
  amount: "0",
};
const sim = await api("/api/execute/transfer", {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ ...transfer, simulate: true }),
});
if (!sim.body.success || sim.body.wouldRevert) {
  throw new Error("simulation failed");
}
const exec = await api("/api/execute/transfer", {
  method: "POST",
  headers: { ...auth, "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify(transfer),
});

// 5. The status response carries the authoritative onchain proof.
const { body: status } = await api(
  `/api/execute/${exec.body.executionId}/status`,
  { headers: auth }
);
console.log(status.status, status.transactionLink);
```
