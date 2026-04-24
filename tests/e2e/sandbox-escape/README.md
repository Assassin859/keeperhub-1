# Sandbox Escape-Matrix E2E Tests (v1.9)

These tests prove that an escape from the KeeperHub Code action node — running inside the dedicated `keeperhub-sandbox-{env}` Pod — cannot read secrets from the main `keeperhub-{env}` Pod.

## Threat model recap

The Code action node runs user-supplied JavaScript. `node:vm.runInContext` is NOT a cryptographic sandbox (native constructors leak the host prototype chain; `Error.constructor("return process")()` reaches `process`). The v1.9 defence is:

1. **Separate Pod** (`keeperhub-sandbox-{env}`, different PID namespace) — closes `/proc/<main-pid>/environ`.
2. **Scrubbed env (CHILD_ENV_ALLOWLIST)** — closes `process.env` even inside the sandbox.
3. **Dedicated ServiceAccount with no RoleBindings and `automountServiceAccountToken: false` at SA + Pod level** — closes `/var/run/secrets/kubernetes.io/serviceaccount/token`.
4. **No `eks.amazonaws.com/role-arn` IRSA annotation on the SA** — closes `/var/run/secrets/eks.amazonaws.com/serviceaccount/token`.

These five tests assert those four paths and one composite via `Error.constructor("return process")()`.

## Running against staging

### Prerequisites

- `kubectl` context pointed at `maker-staging` with read access to `keeperhub` namespace.
- AWS credentials exported (for EKS token exchange).
- The staging sandbox release is deployed (see `deploy/keeperhub-sandbox/staging/`).
- A `STAGING_API_TOKEN` with permission to create + execute workflows.
- `SANDBOX_BACKEND=remote` is set in the main `keeperhub-staging` Deployment env (see `deploy/keeperhub/staging/values.yaml` v1.9 additions).

### One-time planted sentinel

Before running the E2E suite, plant a sentinel value in the main pod's env so the tests can assert it is NOT reachable from inside the sandbox. Operators do this via the Parameter Store + ExternalSecrets refresh:

```bash
# Write a test-only sentinel to SSM (staging only — never in prod).
aws ssm put-parameter \
  --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary \
  --type SecureString \
  --value "KH_ESCAPE_CANARY_$(openssl rand -hex 8)" \
  --overwrite

# Add it to deploy/keeperhub/staging/values.yaml shared_env as
# KH_ESCAPE_CANARY_VALUE (parameterStore type), then helm upgrade to
# propagate. DO NOT commit the sentinel value.

# Capture the sentinel locally for the test runner:
export EXPECTED_SENTINEL=$(aws ssm get-parameter \
  --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary \
  --with-decryption --query Parameter.Value --output text)
```

### Run

```bash
STAGING_URL=https://staging.keeperhub.com \
STAGING_API_TOKEN=<token> \
EXPECTED_SENTINEL=<value planted above> \
  pnpm exec vitest run tests/e2e/sandbox-escape/escape-matrix.spec.ts
```

The suite runs five tests (TEST-01..05). Each builds a Code workflow with a specific escape payload via the REST API, executes it against staging (which routes to the remote sandbox because `SANDBOX_BACKEND=remote`), and asserts the output does NOT contain `EXPECTED_SENTINEL`.

### Cleanup

```bash
aws ssm delete-parameter \
  --name /eks/techops-staging/keeperhub/_sandbox_escape_test_canary
# Revert values.yaml to remove KH_ESCAPE_CANARY_VALUE, helm upgrade again.
```

## Running against local minikube

If `make setup-local-kubernetes` has installed minikube (see `deploy/local/README.md`), apply the staging manifests against the local cluster:

```bash
helm upgrade --install keeperhub-sandbox \
  techops-services/common \
  --namespace keeperhub \
  -f deploy/keeperhub-sandbox/staging/values.yaml

kubectl apply -f deploy/keeperhub-sandbox/staging/sa.yaml

kubectl -n keeperhub patch deployment keeperhub-sandbox \
  --patch-file deploy/keeperhub-sandbox/staging/pod-automount-patch.yaml

# Plant a local canary directly in the main app Deployment:
kubectl -n keeperhub set env deployment/keeperhub-staging \
  KH_ESCAPE_CANARY_VALUE=KH_ESCAPE_CANARY_$(openssl rand -hex 8)
```

Then run the same `pnpm exec vitest run tests/e2e/sandbox-escape/...` with the minikube tunnel URL.

## Test matrix

| ID | Payload | Assertion |
|----|---------|-----------|
| TEST-01 | `Error.constructor("return process")(); return JSON.stringify(Object.keys(process.env))` | Sandbox returns JS surface but `Object.keys(process.env)` is the CHILD_ENV_ALLOWLIST only (no sentinel). |
| TEST-02 | `const p = Error.constructor("return process")(); return p.mainModule.require("fs").readFileSync("/proc/self/environ", "utf8")` | Returned environ string does NOT contain the sentinel (scrubbed via execve). |
| TEST-03 | Read `/proc/1/environ` and `/proc/<ppid>/environ` | Both return ENOENT or do not contain the sentinel (separate PID namespace). |
| TEST-04 | Read `/var/run/secrets/kubernetes.io/serviceaccount/token` | Returns ENOENT (`automountServiceAccountToken: false`). |
| TEST-05 | Read `/var/run/secrets/eks.amazonaws.com/serviceaccount/token` | Returns ENOENT (no IRSA annotation on SA). |

## Failure triage

- **TEST-01 fails (sentinel found in process.env):** The main-app Deployment's env is leaking into the sandbox Pod — likely a values.yaml misconfiguration that added shared_env to the sandbox release, or a `shareProcessNamespace: true` somewhere. Check `kubectl describe pod keeperhub-sandbox-...`.
- **TEST-02 fails (sentinel in `/proc/self/environ`):** CHILD_ENV_ALLOWLIST was augmented with a non-allowlisted var, OR the sandbox is running as PID 1 inside the Pod without the child_process wrapper. Verify `plugins/code/steps/run-code.ts` still uses spawn + buildChildEnv.
- **TEST-03 fails:** Two Pods are in the same PID namespace (`shareProcessNamespace`). Banned by cluster admission policy; if this fails the fix is a k8s audit, not a code change.
- **TEST-04 fails:** `automountServiceAccountToken: false` is missing from either the SA or the Pod spec. Check both `sa.yaml` and the `pod-automount-patch.yaml` were applied.
- **TEST-05 fails:** The `eks.amazonaws.com/role-arn` annotation slipped onto the sandbox SA. CI grep-check in pr-checks.yml should have caught this pre-merge.
