#!/usr/bin/env bash
# Deploy the production stack from this repo. Self-locates, so it runs from any cwd.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Building and starting containers"
docker compose up -d --build

echo "==> Container status"
docker compose ps

# Smoke: retry until the target answers 200, fail the deploy if it never does.
check() {
  local name="$1" url="$2"
  echo -n "==> smoke: $name "
  local code=""
  for _ in $(seq 1 30); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
      echo "200 OK"
      return 0
    fi
    sleep 2
  done
  echo "FAILED (last code: ${code:-none})"
  return 1
}

check "frontend http://odds.lan/" "http://odds.lan/"
check "backend http://odds.lan/api/health" "http://odds.lan/api/health"

echo "==> Deploy complete: production stack is up and smoke tests passed."
