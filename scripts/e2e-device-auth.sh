#!/usr/bin/env bash
#
# End-to-end regression harness for the per-device server-auth + liveness lock
# features (ADR-0010 / ADR-0011). Self-contained: it builds the backend, then
# for each stage boots it with a specific env on a throwaway port + temp SQLite
# DB, runs scripts/test-client.ts against it, and asserts. Nothing touches your
# dev server or dev data.
#
# Stages:
#   1. transition mode      (DEVICE_AUTH_REQUIRED unset)        → full suite green
#   2. enforcement          (DEVICE_AUTH_REQUIRED=true)         → full suite green
#                            (pairing must still bootstrap; a PRE-UPDATE/legacy
#                             client without a bound auth key fails closed → 401)
#   3. liveness lock         (PRIMARY_LIVENESS_MAX_IDLE_MS=120s) → lock + reversible unlock
#
# Usage:
#   bash scripts/e2e-device-auth.sh
#   E2E_PORT=3401 bash scripts/e2e-device-auth.sh   # override port
#
# Exit code: 0 if every stage passes, 1 otherwise (CI-friendly).

set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-3399}"
HOSTPORT="127.0.0.1:${PORT}"
URL="http://${HOSTPORT}"
DBDIR="$(mktemp -d)"
SERVER_PID=""
FAIL=0

cleanup() {
  stop_server
  rm -rf "$DBDIR"
}
trap cleanup EXIT INT TERM

stop_server() {
  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  SERVER_PID=""
}

# start_server KEY=VAL [KEY=VAL ...] — fresh DB, given extra env, wait for ready.
start_server() {
  stop_server
  rm -f "${DBDIR}"/tillit.db*
  env \
    DEPLOYMENT_MODE=selfhosted \
    NODE_ENV=production \
    SQLITE_DATA_DIR="${DBDIR}" \
    APP_PORT="${PORT}" \
    AUTH_ALLOWED_HOSTS="${HOSTPORT}" \
    LOADTEST_MODE=false \
    LOG_LEVEL=warn \
    THROTTLE_GLOBAL_LIMIT=100000 \
    THROTTLE_AUTH_LIMIT=100000 \
    THROTTLE_KEYS_LIMIT=100000 \
    "$@" \
    node dist/main >"${DBDIR}/server.log" 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 80); do
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "  ✗ il server è morto durante l'avvio. Log:"
      sed 's/^/    /' "${DBDIR}/server.log"
      return 1
    fi
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "${URL}/auth/status" 2>/dev/null || true)"
    if [ "${code}" = "401" ] || [ "${code}" = "200" ]; then
      return 0
    fi
    sleep 0.5
  done
  echo "  ✗ timeout in attesa del server su ${URL}. Log:"
  sed 's/^/    /' "${DBDIR}/server.log"
  return 1
}

run_client() {
  node_modules/.bin/ts-node --transpile-only scripts/test-client.ts "${URL}" "$@"
}

stage() {
  local title="$1"
  shift
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  ${title}"
  echo "════════════════════════════════════════════════════════════════"
}

# ── JWT keys (self-sufficient for a clean runner / CI) ───────────────────────
if [ ! -f keys/private.pem ] || [ ! -f keys/public.pem ]; then
  echo "Generating JWT keys…"
  bash scripts/generate-keys.sh >/dev/null 2>&1 || {
    echo "✗ generazione chiavi fallita"; exit 1;
  }
fi

# ── build once (prod artifact, like a real deploy) ───────────────────────────
echo "Building backend (pnpm run build)…"
if ! pnpm run build >"${DBDIR}/build.log" 2>&1; then
  echo "✗ build fallita. Log:"
  sed 's/^/  /' "${DBDIR}/build.log"
  exit 1
fi

# ── Stage 1: transition mode ─────────────────────────────────────────────────
stage "Stage 1 — transition mode (DEVICE_AUTH_REQUIRED unset)"
if start_server; then
  run_client || FAIL=1
else
  FAIL=1
fi

# ── Stage 2: enforcement ──────────────────────────────────────────────────────
stage "Stage 2 — enforcement (DEVICE_AUTH_REQUIRED=true)"
if start_server DEVICE_AUTH_REQUIRED=true; then
  # --expect-enforce: the backward-compat scenario asserts the legacy re-login
  # fails CLOSED (401 DEVICE_AUTH_REQUIRED) instead of 2xx under enforcement.
  run_client --expect-enforce || FAIL=1
else
  FAIL=1
fi

# ── Stage 3: liveness lock ────────────────────────────────────────────────────
stage "Stage 3 — liveness lock (PRIMARY_LIVENESS_MAX_IDLE_MS=120000)"
if start_server PRIMARY_LIVENESS_MAX_IDLE_MS=120000; then
  run_client --liveness --db "${DBDIR}/tillit.db" || FAIL=1
else
  FAIL=1
fi

stop_server

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "${FAIL}" -eq 0 ]; then
  echo "  ✅ E2E device-auth/liveness: TUTTI GLI STAGE OK"
else
  echo "  ❌ E2E device-auth/liveness: ALMENO UNO STAGE FALLITO"
fi
echo "════════════════════════════════════════════════════════════════"
exit "${FAIL}"
