#!/usr/bin/env bash
# Local full-stack rig for the protocol-coverage suites.
#
# Reproduces the e2e-vitest-ephemeral CI environment on a developer
# machine so suite changes are validated in minutes instead of a
# 30-minute CI round: shared postgres database, anvil mainnet and
# Sepolia forks, a production app build, and the same chains-row
# patching CI applies. All node/pnpm invocations run inside a node:22
# container - no host node required.
#
#   scripts/protocol-local.sh up            # build + start everything
#   scripts/protocol-local.sh test [suite]  # run all suites or one (e.g. superfluid)
#   scripts/protocol-local.sh sim [chain]   # Tier 1 fork simulations (no app needed)
#   scripts/protocol-local.sh down [--purge]
#
# Signing: real on-chain writes need TURNKEY_API_PUBLIC_KEY,
# TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID exported in the
# calling shell (`up` seeds a real Turnkey wallet when they are set).
# Without them, `up` seeds a placeholder wallet row: dispatch and read
# paths work, write steps fail loudly at signing. Keys are only ever
# passed as process environment - never written to disk.
#
# Fork upstreams are the public defaults from docker-compose.yml. Known
# constraint (see specs/protocol-coverage-methodology.md): a Sepolia
# fork on a non-archive public upstream is only healthy for ~15 minutes,
# so `test` restarts it for a fresh window first, same as CI.

set -euo pipefail

APP_PORT="${APP_PORT:-3001}"
DB_NAME="${PROTOCOL_LOCAL_DB:-keeperhub_protocol_local}"
DB_PORT="${PROTOCOL_LOCAL_DB_PORT:-5433}"
APP_CONTAINER=kh-protocol-local-app
NODE_IMAGE=node:22
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_URL="postgresql://postgres:postgres@localhost:${DB_PORT}/${DB_NAME}"
RESULTS_FILE=".claude/protocol-local-results.json"

# Logs go to stderr so helpers whose stdout is captured by command
# substitution (mainnet_upstream) can log without corrupting their result.
log() { printf '[protocol-local] %s\n' "$*" >&2; }

run_node() {
  # shellcheck disable=SC2068 # word-splitting of env pairs is intended
  docker run --rm --network host -v "$REPO_DIR":/app -w /app \
    -e DATABASE_URL="$DATABASE_URL" \
    ${TURNKEY_API_PUBLIC_KEY:+-e TURNKEY_API_PUBLIC_KEY} \
    ${TURNKEY_API_PRIVATE_KEY:+-e TURNKEY_API_PRIVATE_KEY} \
    ${TURNKEY_ORGANIZATION_ID:+-e TURNKEY_ORGANIZATION_ID} \
    "$NODE_IMAGE" bash -c "corepack enable >/dev/null 2>&1 && corepack prepare pnpm@9 --activate >/dev/null 2>&1 && $*"
}

db_container() {
  docker ps --filter "name=keeperhub-db" --filter "status=running" \
    --format '{{.Names}}' | grep -vi 'test' | head -n1
}

psql_local() {
  local container
  container="$(db_container)"
  if [ -z "$container" ]; then
    log "no running keeperhub db container; start it: docker compose --profile infra up -d db"
    exit 1
  fi
  docker exec "$container" psql -U postgres "$@"
}

wait_for_fork() {
  local port="$1" chain_hex="$2" name="$3" retries=0
  until curl -sf -m 5 -X POST "http://localhost:${port}" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' | grep -q "\"${chain_hex}\""; do
    retries=$((retries + 1))
    if [ "$retries" -ge 30 ]; then
      log "${name} fork did not become ready on :${port} in 60s"
      docker logs "$name" 2>&1 | tail -10 || true
      exit 1
    fi
    sleep 2
  done
  log "${name} ready on :${port}"
}

mainnet_upstream() {
  # Precedence: explicit env, then an archive upstream adopted from an
  # already-present fork container (a developer may run one with their
  # own archive key), then the public default - which only sustains a
  # fork for ~15 minutes (see the spec).
  if [ -n "${ANVIL_FORK_MAINNET_URL:-}" ]; then
    printf '%s' "$ANVIL_FORK_MAINNET_URL"
    return
  fi
  local adopted
  adopted=$(docker ps -a --filter "name=anvil" --format '{{.Names}}' \
    | while read -r c; do docker inspect "$c" --format '{{join .Config.Cmd " "}}' 2>/dev/null; done \
    | grep -oE 'https://[^ ]*(alchemy|infura|chainstack|drpc)[^ ]*' | head -n1) || true
  if [ -n "$adopted" ]; then
    log "adopting archive mainnet upstream from an existing fork container"
    printf '%s' "$adopted"
    return
  fi
  log "WARNING: mainnet fork on public upstream - healthy for ~15 minutes only"
  printf '%s' "https://ethereum-rpc.publicnode.com"
}

start_fork() {
  local name="$1" port="$2" chain_id="$3" chain_hex="$4" upstream="$5"
  docker rm -f "$name" 2>/dev/null || true
  docker run -d --name "$name" -p "${port}:8545" --entrypoint anvil \
    ghcr.io/foundry-rs/foundry:latest \
    --host 0.0.0.0 --fork-url "$upstream" --chain-id "$chain_id" --block-time 1 >/dev/null
  wait_for_fork "$port" "$chain_hex" "$name"
}

start_forks() {
  # Rig-owned containers (not the compose service names): the compose
  # services declare fixed container_names that collide across checkouts
  # and with manually started forks. Ports must match the chains-row
  # patch below; override holders must be stopped or ports overridden.
  start_fork kh-protocol-local-fork-sepolia "${SEPOLIA_FORK_PORT:-8547}" 11155111 "0xaa36a7" \
    "${ANVIL_FORK_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
  start_fork kh-protocol-local-fork-mainnet "${MAINNET_FORK_PORT:-8548}" 1 "0x1" "$(mainnet_upstream)"
}

patch_chains() {
  # Same patch CI applies: point forked chains at the local forks and
  # null the fallback so nothing leaks to live networks on failure.
  # Ports must track the same overrides start_forks honors, or a port
  # override would leave the chains rows pointing at dead sockets.
  psql_local -d "$DB_NAME" \
    -c "UPDATE chains SET default_primary_rpc = 'http://localhost:${SEPOLIA_FORK_PORT:-8547}', default_fallback_rpc = NULL WHERE chain_id = 11155111" \
    -c "UPDATE chains SET default_primary_rpc = 'http://localhost:${MAINNET_FORK_PORT:-8548}', default_fallback_rpc = NULL WHERE chain_id = 1" >/dev/null
  log "chains rows patched to local forks (:${SEPOLIA_FORK_PORT:-8547}, :${MAINNET_FORK_PORT:-8548})"
}

cmd_up() {
  psql_local -c "CREATE DATABASE \"${DB_NAME}\"" 2>/dev/null || true
  log "database ${DB_NAME} ready on :${DB_PORT}"

  log "workflow schema + migrations + seeds (containerized pnpm)"
  run_node "pnpm db:setup-workflow >/dev/null && pnpm db:migrate >/dev/null && CHAIN_RPC_CONFIG=\"\${CHAIN_RPC_CONFIG:-}\" pnpm db:seed | tail -1"

  if [ -n "${TURNKEY_API_PUBLIC_KEY:-}" ] && [ -n "${TURNKEY_API_PRIVATE_KEY:-}" ] && [ -n "${TURNKEY_ORGANIZATION_ID:-}" ]; then
    log "seeding real Turnkey wallet"
    run_node "pnpm db:seed-test-wallet | tail -2"
  else
    log "TURNKEY_* not set: seeding placeholder wallet (writes will fail at signing)"
    # db:seed-test-wallet creates the persistent user/org/member before it
    # refuses on the missing Turnkey env - run it for those side effects
    # and tolerate the refusal, then satisfy the wallet lookup ourselves.
    run_node "pnpm db:seed-test-wallet >/dev/null 2>&1 || true"
    psql_local -d "$DB_NAME" -c "
      INSERT INTO organization_wallets (id, user_id, email, wallet_address, organization_id, turnkey_sub_org_id, turnkey_wallet_id, turnkey_private_key_id, is_active)
      SELECT 'protocol-local-placeholder', u.id, u.email, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', o.id, 'placeholder', 'placeholder', 'placeholder', true
      FROM users u JOIN organization o ON o.slug = 'e2e-test-org'
      WHERE u.email = 'pr-test-do-not-delete@techops.services'
      ON CONFLICT (id) DO NOTHING" | tail -1
  fi

  start_forks
  patch_chains

  if [ ! -f "$REPO_DIR/.next/BUILD_ID" ] || [ "${1:-}" = "--rebuild" ]; then
    log "production build (several minutes; sandbox guards required at build time)"
    run_node "BETTER_AUTH_SECRET=protocol-local-secret CI=true TEST_API_KEY=protocol-local-api-key NEXT_PUBLIC_BILLING_ENABLED=true NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED=true SANDBOX_BACKEND=remote SANDBOX_URL=http://localhost:8787 pnpm build 2>&1 | tail -3"
  else
    log "reusing existing production build (.next/BUILD_ID present; pass --rebuild to force)"
  fi

  docker rm -f "$APP_CONTAINER" 2>/dev/null || true
  docker run -d --name "$APP_CONTAINER" --network host -v "$REPO_DIR":/app -w /app \
    -e PORT="$APP_PORT" \
    -e DATABASE_URL="$DATABASE_URL" \
    -e BETTER_AUTH_SECRET=protocol-local-secret \
    -e OAUTH_JWT_SECRET=protocol-local-oauth-secret \
    -e MCP_SESSION_SECRET=protocol-local-mcp-secret \
    -e CI=true \
    -e TEST_API_KEY=protocol-local-api-key \
    -e INTEGRATION_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    -e WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
    -e AWS_ENDPOINT_URL=http://localhost:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e SAFE_FETCH_SHADOW=true \
    -e SANDBOX_BACKEND=remote -e SANDBOX_URL=http://localhost:8787 \
    ${TURNKEY_API_PUBLIC_KEY:+-e TURNKEY_API_PUBLIC_KEY} \
    ${TURNKEY_API_PRIVATE_KEY:+-e TURNKEY_API_PRIVATE_KEY} \
    ${TURNKEY_ORGANIZATION_ID:+-e TURNKEY_ORGANIZATION_ID} \
    "$NODE_IMAGE" bash -c "corepack enable >/dev/null 2>&1 && corepack prepare pnpm@9 --activate >/dev/null 2>&1 && pnpm start" >/dev/null

  local retries=0
  until curl -sf -m 3 "http://localhost:${APP_PORT}" >/dev/null 2>&1; do
    retries=$((retries + 1))
    if [ "$retries" -ge 40 ]; then
      log "app did not become ready on :${APP_PORT}"
      docker logs "$APP_CONTAINER" 2>&1 | tail -20
      exit 1
    fi
    sleep 3
  done
  log "app ready on :${APP_PORT} - rig is up"
}

cmd_test() {
  local suite="${1:-}"
  local target="tests/e2e/vitest/protocol-coverage"
  if [ -n "$suite" ]; then
    target="tests/e2e/vitest/protocol-coverage/${suite}"
  fi

  # Fresh upstream window for the Sepolia fork (recreate re-pins to the
  # current head), then re-assert the chains patch (some general e2e
  # tests rewrite the Sepolia row).
  start_fork kh-protocol-local-fork-sepolia "${SEPOLIA_FORK_PORT:-8547}" 11155111 "0xaa36a7" \
    "${ANVIL_FORK_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
  patch_chains

  log "running ${target}"
  local started ended
  started=$(date +%s)
  # ANVIL_FORK_MAINNET_URL gates the mainnet suites (the actual RPC the
  # app uses comes from the patched chains row); TESTNET_FUNDER_PK gates
  # ajna's live-Base reads and passes through only when the caller set it.
  run_node "PROTOCOL_E2E_BASE_URL=http://localhost:${APP_PORT} PROTOCOL_E2E_SEPOLIA_FORK=1 ANVIL_FORK_MAINNET_URL=http://localhost:${MAINNET_FORK_PORT:-8548} ${TESTNET_FUNDER_PK:+TESTNET_FUNDER_PK=$TESTNET_FUNDER_PK} pnpm vitest run ${target} --reporter=default --reporter=json --outputFile=${RESULTS_FILE}" || true
  ended=$(date +%s)
  log "suite wall-clock: $((ended - started))s"
  log "coverage report with executed results:"
  run_node "pnpm coverage:report --results ${RESULTS_FILE}"
}

cmd_sim() {
  local chain="${1:-}"
  local target="tests/e2e/vitest/protocol-simulation"
  # Chain selection is env-driven: chains.test.ts gates each chain on its
  # PROTOCOL_SIM_RPC_<chainId> var, so export only the requested one(s).
  local env_rpc
  case "$chain" in
    "")
      env_rpc="PROTOCOL_SIM_RPC_1=http://localhost:${MAINNET_FORK_PORT:-8548} PROTOCOL_SIM_RPC_11155111=http://localhost:${SEPOLIA_FORK_PORT:-8547} ${PROTOCOL_SIM_RPC_8453:+PROTOCOL_SIM_RPC_8453=$PROTOCOL_SIM_RPC_8453}"
      ;;
    ethereum)
      env_rpc="PROTOCOL_SIM_RPC_1=http://localhost:${MAINNET_FORK_PORT:-8548}"
      ;;
    sepolia)
      env_rpc="PROTOCOL_SIM_RPC_11155111=http://localhost:${SEPOLIA_FORK_PORT:-8547}"
      ;;
    base)
      # The rig runs no Base fork; the caller must provide the endpoint.
      if [ -z "${PROTOCOL_SIM_RPC_8453:-}" ]; then
        log "PROTOCOL_SIM_RPC_8453 is not set - every base test will self-skip"
      fi
      env_rpc="${PROTOCOL_SIM_RPC_8453:+PROTOCOL_SIM_RPC_8453=$PROTOCOL_SIM_RPC_8453}"
      ;;
    *)
      log "unknown chain '${chain}' (expected: ethereum, sepolia, base)"
      exit 1
      ;;
  esac
  # Tier 1 needs only the forks - no app, no database beyond none at all.
  start_forks
  log "running Tier 1 simulations: ${target}${chain:+ (${chain})}"
  local started ended
  started=$(date +%s)
  run_node "${env_rpc} pnpm vitest run ${target} --reporter=default --reporter=json --outputFile=.claude/protocol-sim-results.json" || true
  ended=$(date +%s)
  log "simulation wall-clock: $((ended - started))s"
}

cmd_down() {
  docker rm -f "$APP_CONTAINER" kh-protocol-local-fork-sepolia kh-protocol-local-fork-mainnet 2>/dev/null || true
  if [ "${1:-}" = "--purge" ]; then
    psql_local -c "DROP DATABASE IF EXISTS \"${DB_NAME}\""
    log "database ${DB_NAME} dropped"
  fi
  log "rig is down"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  test) shift; cmd_test "$@" ;;
  sim) shift; cmd_sim "$@" ;;
  down) shift; cmd_down "$@" ;;
  *) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20; exit 1 ;;
esac
