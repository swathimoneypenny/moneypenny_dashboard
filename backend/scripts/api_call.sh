#!/usr/bin/env bash
# Auto-login + call any auth-protected dashboard endpoint on localhost.
#
# Usage:
#   ./scripts/api_call.sh /api/roster/status
#   ./scripts/api_call.sh /api/roster/diff
#   ./scripts/api_call.sh /api/team/team_a/roster
#   ./scripts/api_call.sh /api/team/team_i/monthly
#   ./scripts/api_call.sh -X POST /api/roster/refresh
#
# Reads DASHBOARD_PASSWORD from the environment, else from backend/.env.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$BACKEND_DIR/.env}"
BASE_URL="${BASE_URL:-http://localhost:8000}"

METHOD="GET"
if [ "${1:-}" = "-X" ]; then
    METHOD="${2:?-X needs a method}"
    shift 2
fi
ENDPOINT="${1:-/api/roster/status}"

if [ -z "${DASHBOARD_PASSWORD:-}" ]; then
    if [ ! -r "$ENV_FILE" ]; then
        echo "No DASHBOARD_PASSWORD in env and cannot read $ENV_FILE" >&2
        exit 1
    fi
    # -m1 + anchored ^ so DASHBOARD_PASSWORD_OLD= can't win; -f2- keeps any '='
    # inside the value; then strip one layer of surrounding quotes.
    DASHBOARD_PASSWORD="$(grep -m1 '^DASHBOARD_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')"
    DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD%\"}"; DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD#\"}"
    DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD%\'}"; DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD#\'}"
fi

if [ -z "$DASHBOARD_PASSWORD" ]; then
    echo "DASHBOARD_PASSWORD is empty — is auth disabled on this box?" >&2
    exit 1
fi

# --data via stdin so the password never lands in the process list.
LOGIN_JSON="$(printf '%s' "$DASHBOARD_PASSWORD" \
    | python3 -c 'import json,sys; print(json.dumps({"password": sys.stdin.read()}))')"

TOKEN="$(printf '%s' "$LOGIN_JSON" \
    | curl -sS -X POST "$BASE_URL/api/auth/login" \
        -H "Content-Type: application/json" --data-binary @- \
    | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("token", ""))
except Exception:
    print("")')"

if [ -z "$TOKEN" ]; then
    echo "Login failed against $BASE_URL — check the backend is up and the password is current." >&2
    exit 1
fi

# Pretty-print JSON when it is JSON, pass anything else through untouched.
curl -sS -X "$METHOD" -H "Authorization: Bearer $TOKEN" "$BASE_URL$ENDPOINT" \
    | python3 -c 'import sys,json
raw = sys.stdin.read()
try:
    print(json.dumps(json.loads(raw), indent=2))
except Exception:
    sys.stdout.write(raw)'
