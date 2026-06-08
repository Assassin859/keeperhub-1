#!/bin/sh
set -e

# Cron runner for the execution digest: GET the /api/internal/execution-digest
# endpoint authenticated with the scheduler service key. Pass the full URL as
# the first argument. Shares the curl-with-service-key shape of reaper.sh but is
# a distinct job (scheduled digest, not stale-execution reaping).

URL="$1"

if [ -z "$URL" ]; then
  echo '{"error":"missing URL argument"}' >&2
  exit 1
fi

if [ -z "$SCHEDULER_SERVICE_API_KEY" ]; then
  echo '{"error":"SCHEDULER_SERVICE_API_KEY not set"}' >&2
  exit 1
fi

echo "Environment variables are ready"

curl -sS \
  -w '\n{"http_code":%{http_code},"time_total":%{time_total}}' \
  -H "X-Service-Key: ${SCHEDULER_SERVICE_API_KEY}" \
  "$URL"
