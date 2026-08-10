#!/usr/bin/env bash
# Configuration for a self-hosted KeeperHub install.
#
# Sourced by install.sh and by the scripts under test-harness/.
#
# This file no longer substitutes anything into the values files. Those are
# ordinary Helm input now, and every setting below is passed through as a --set
# on the chart's `global` map. The values files remain usable without this
# script; it exists to turn environment variables into helm flags, run the
# preflight checks helm cannot, and refuse to guess a cluster.
#
# One thing here is a cryptographic input rather than a mere address:
#
#   The SQS queue URL is signed. Producers sign
#   "sqs\n<queueUrl>\n<caller>\n<sha256(body)>\n<ts>" (lib/sqs-message-auth.ts)
#   and the executor verifies against its own SQS_QUEUE_URL. One byte of
#   difference between any producer and the consumer rejects every trigger as
#   bad_signature, visible only as a warn line while all pods stay green. Under
#   the bundled queue the chart computes it and strictEndpointCheck verifies it;
#   under QUEUE_MODE=byo you supply it and nothing can check it for you.
#
# Override any of these in the environment before running install.sh.
#
# shellcheck disable=SC2034
# Most variables here are consumed by the scripts that source this file.

# The cluster and namespace to install into. KUBE_CONTEXT is required rather
# than defaulted, because a bare kubectl follows whatever context happens to be
# current, and on a machine with production access that is how an install lands
# somewhere it should not.
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
NAMESPACE="${NAMESPACE:-keeperhub}"
RELEASE="${RELEASE:-keeperhub}"

CHART_REPO_NAME="techops-services"
CHART_REPO_URL="https://techops-services.github.io/helm-charts"
CHART_NAME="techops-services/keeperhub-stack"
CHART_VERSION="${CHART_VERSION:-0.5.0}"
# Point at a working-tree chart instead of the published one, for developing
# chart changes alongside this profile: CHART_DIR=../../../helm-charts/charts/keeperhub-stack
CHART_DIR="${CHART_DIR:-}"
HELM_TIMEOUT="${HELM_TIMEOUT:-15m0s}"

# PROFILE=minikube also merges values.minikube.yaml, which carries the settings
# that only make sense on the throwaway cluster test-harness/ builds. Anything
# else installs the base profile alone.
PROFILE="${PROFILE:-}"

# Where the images come from. No defaults: the chart fails the render naming the
# value rather than installing something that cannot pull.
IMAGE_REPO="${IMAGE_REPO:-}"
IMAGE_TAG="${IMAGE_TAG:-}"
IMAGE_PULL_POLICY="${IMAGE_PULL_POLICY:-}"

# The hostname the app is served on, and how it is exposed.
#
# One caveat that applies to every hostname outside *.keeperhub.com:
# lib/trusted-origins.ts hardcodes the trusted-origin list to http://localhost:*,
# http://127.0.0.1:* and https://*.keeperhub.com, with no environment variable to
# extend it. That list backs the CSRF guard in proxy.ts and better-auth, so on
# any other hostname every cookie-authenticated POST/PATCH/PUT/DELETE is
# rejected. The UI still loads and reads fine, so it looks like the app works
# until you try to save: enabling a workflow returns "Failed to update workflow
# state" and the only trace is "[csrf] blocked: untrusted origin" in the app log.
#
# Making the trusted origins configurable is a prerequisite for any client
# domain, and is tracked separately.
APP_HOST="${APP_HOST:-}"
INGRESS_CLASS="${INGRESS_CLASS:-}"
TLS_ISSUER="${TLS_ISSUER:-}"
FROM_ADDRESS="${FROM_ADDRESS:-}"

# Cloudflare Turnstile.
#
# The two keys are NOT delivered the same way, and getting that wrong yields a
# signup form that renders and then fails:
#
#   TURNSTILE_SECRET_KEY is read at runtime, so the values file supplies it.
#     Without it lib/auth.ts throws at module load and every route importing the
#     auth module returns 500.
#   NEXT_PUBLIC_TURNSTILE_SITE_KEY is read by a client component
#     (components/auth/connect-auth-panel.tsx), so Next.js inlines it into the
#     browser bundle at BUILD time. Setting it in the values file does nothing;
#     it has to be a build arg. Symptom when missing: the captcha widget never
#     renders, the browser sends no token, and signup fails with
#     "Missing CAPTCHA response".
TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-1x00000000000000000000AA}"
TURNSTILE_SECRET_KEY="${TURNSTILE_SECRET_KEY:-}"

# --- Queue -------------------------------------------------------------------
# QUEUE_MODE=bundled  the chart runs ElasticMQ, persistent, single node
# QUEUE_MODE=byo      point the values at your own SQS-compatible endpoint,
#                     including real AWS SQS
#
# ElasticMQ speaks the SQS API, so nothing in the application changes between
# the two: the same @aws-sdk/client-sqs reaches either through AWS_ENDPOINT_URL.
QUEUE_MODE="${QUEUE_MODE:-bundled}"

# Under QUEUE_MODE=bundled the chart computes every queue address from the
# release namespace, so nothing here applies.
#
# Under QUEUE_MODE=byo an UNSET endpoint is meaningful: it is what sends the SDK
# to real AWS SQS with its normal credential resolution. Setting it selects a
# self-hosted SQS-compatible endpoint instead, and install.sh merges the extra
# values fragment that carries it.
AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-}"
SQS_QUEUE_URL="${SQS_QUEUE_URL:-}"
SQS_DLQ_URL="${SQS_DLQ_URL:-}"
AWS_REGION="${AWS_REGION:-}"

# Two different jobs, depending on whether an endpoint is set.
#
# With a custom endpoint these are dummies that exist only because the SDK
# refuses to sign a request without credentials; ElasticMQ ignores them.
#
# Against real AWS they are real credentials. They then go into a Secret rather
# than a values file, and AWS_SESSION_TOKEN carries the temporary-credential
# case. Leave all three empty to use the default credential chain instead, which
# is what an IRSA-enabled cluster wants.
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}"
AWS_CREDENTIALS_SECRET="${AWS_CREDENTIALS_SECRET:-keeperhub-aws-credentials}"

# True when the operator supplied real AWS credentials for a real SQS queue.
# Deliberately not true for the ElasticMQ dummies, which travel as plain values.
use_aws_credentials() {
    [ "$QUEUE_MODE" = byo ] && [ -z "$AWS_ENDPOINT_URL" ] \
        && [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ]
}

# --- Database ----------------------------------------------------------------
# DB_MODE=bundled  the chart runs PostgreSQL as a CloudNativePG Cluster, which
#                  brings HA, failover, backup and restore with it. Requires the
#                  CNPG operator to be installed cluster-wide first.
# DB_MODE=byo      supply DATABASE_URL yourself, as a Kubernetes Secret.
DB_MODE="${DB_MODE:-bundled}"
PG_INSTANCES="${PG_INSTANCES:-}"
PG_STORAGE_SIZE="${PG_STORAGE_SIZE:-}"

# Name and key of the Secret holding DATABASE_URL. In bundled mode the chart
# writes it; in byo mode you create it and the chart reads it.
DB_SECRET_NAME="${DB_SECRET_NAME:-keeperhub-db}"
DB_SECRET_KEY="${DB_SECRET_KEY:-DATABASE_URL}"

# --- Runner credentials ------------------------------------------------------
# The executor hands runner Job pods their credentials by secretKeyRef, building
# each reference as "<prefix>-<slug>" with the key equal to the name
# (keeperhub-executor/k8s-job.ts). Only DATABASE_URL and
# INTEGRATION_ENCRYPTION_KEY are non-optional there; the eight below are marked
# optional, so a runner with none of them starts, exits 0 and looks healthy while
# every step that needed one silently did nothing.
#
# The optionality lives in application code, which this programme does not
# change. What the install layer can do is say which are absent, at install time
# rather than after a confusing execution.
RUNNER_SECRET_PREFIX="${RUNNER_SECRET_PREFIX:-keeperhub-executor}"
STRICT_RUNNER_SECRETS="${STRICT_RUNNER_SECRETS:-false}"

# slug|what stops working without it
RUNNER_OPTIONAL_SECRETS=(
    "chain-rpc-config|web3 steps have no RPC endpoints and cannot reach any chain"
    "etherscan-api-key|contract ABI auto-fetch fails, so web3 steps needing an ABI fail"
    "metrics-ingest-token|runner metrics are not shipped, so executions are invisible"
    "openai-api-key|AI steps and AI workflow generation fail"
    "sendgrid-api-key|email steps send nothing"
    "simple-account-7702-address|EIP-7702 smart-account steps fail"
    "turnkey-api-private-key|managed wallet signing fails"
    "turnkey-api-public-key|managed wallet signing fails"
)

validate_modes() {
    case "$DB_MODE" in bundled|byo) ;; *) echo "DB_MODE must be 'bundled' or 'byo', got '$DB_MODE'" >&2; exit 1 ;; esac
    case "$QUEUE_MODE" in bundled|byo) ;; *) echo "QUEUE_MODE must be 'bundled' or 'byo', got '$QUEUE_MODE'" >&2; exit 1 ;; esac
    if [ "$QUEUE_MODE" = byo ] && { [ -z "$SQS_QUEUE_URL" ] || [ -z "$SQS_DLQ_URL" ]; }; then
        cat >&2 <<EOF
QUEUE_MODE=byo needs SQS_QUEUE_URL and SQS_DLQ_URL.

Real AWS SQS - give both in full and leave AWS_ENDPOINT_URL unset, so the SDK
resolves credentials the normal way:

    SQS_QUEUE_URL=https://sqs.<region>.amazonaws.com/<account>/<queue>
    SQS_DLQ_URL=https://sqs.<region>.amazonaws.com/<account>/<queue>-dlq

Your own SQS-compatible endpoint - set AWS_ENDPOINT_URL as well:

    AWS_ENDPOINT_URL=http://my-queue.my-namespace.svc.cluster.local:9324
EOF
        exit 1
    fi
}

# Assert that a constant hardcoded in a test-harness script still matches the
# overlay it mirrors.
#
# The harness runs before anything is deployed, so a few values - the local image
# repository, the mkcert issuer, the hostname - cannot be discovered and have to
# be written down twice: once in values.minikube.yaml, which the install reads,
# and once in the script. This makes the second copy fail loudly when the first
# one changes, instead of the script quietly building an image nothing pulls or
# applying a ClusterIssuer with a blank name.
#
# Structural on purpose. A grep for the bare value would be satisfied by a
# mention in a comment.
assert_overlay() {
    local key="$1" want="$2" overlay="${3:-$SCRIPT_DIR/../values.minikube.yaml}"
    if ! grep -qE "^[[:space:]]*${key}:[[:space:]]*\"?${want}\"?[[:space:]]*$" "$overlay"; then
        echo "Harness constant ${key}=${want} no longer matches $(basename "$overlay")." >&2
        echo "Update the script and the overlay together, or the install and the" >&2
        echo "harness will disagree about what they are building." >&2
        exit 1
    fi
}

kube() {
    kubectl --context "$KUBE_CONTEXT" "$@"
}

kube_ns() {
    kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" "$@"
}

require_tools() {
    local missing=0 tool
    for tool in "$@"; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "  missing: $tool" >&2
            missing=1
        fi
    done
    [ "$missing" -eq 0 ] || { echo "Install the missing tools and re-run." >&2; exit 1; }
}

require_context() {
    if [ -z "$KUBE_CONTEXT" ]; then
        cat >&2 <<EOF
KUBE_CONTEXT is not set.

This install targets whichever cluster you name, and refuses to guess: a bare
kubectl follows the current context, which on a machine with production access
is how an install reaches the wrong cluster.

    KUBE_CONTEXT=<context> $0

Available:
$(kubectl config get-contexts -o name 2>/dev/null | sed 's/^/    /')
EOF
        exit 1
    fi
    if ! kubectl --context "$KUBE_CONTEXT" version >/dev/null 2>&1; then
        echo "Cannot reach cluster for context '$KUBE_CONTEXT'." >&2
        exit 1
    fi
}
