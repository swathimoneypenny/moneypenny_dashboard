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

env_value() {  # value of KEY in $ENV_FILE, one layer of quotes stripped
    local v
    v="$(grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r')" || true
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    printf '%s' "$v"
}

# OTP mode: /api/auth/login answers 410, so mint an admin session token
# directly with the server's DASHBOARD_SESSION_SECRET — the same thing a
# successful OTP login would return. Only works where .env is readable.
# API_CALL_EMAIL picks the identity (must be an admin in access_control.py).
case "$(env_value OTP_AUTH_ENABLED | tr '[:upper:]' '[:lower:]')" in
    1|true|yes)
        PY="$BACKEND_DIR/venv/bin/python3"; [ -x "$PY" ] || PY=python3
        TOKEN="$(cd "$BACKEND_DIR" && \
            DASHBOARD_SESSION_SECRET="$(env_value DASHBOARD_SESSION_SECRET)" \
            API_CALL_EMAIL="${API_CALL_EMAIL:-}" "$PY" -c '
import os, sys, otp_auth
from access_control import USER_ACCESS
email = os.environ.get("API_CALL_EMAIL") or next(
    e for e, a in USER_ACCESS.items() if a["role"] == "admin")
if (USER_ACCESS.get(email.lower()) or {}).get("role") != "admin":
    sys.exit(f"{email} is not an admin in access_control.py")
print(otp_auth.issue_session_token(email.lower()))')"
        ;;
esac

if [ -z "${TOKEN:-}" ] && [ -z "${DASHBOARD_PASSWORD:-}" ]; then
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

if [ -z "${TOKEN:-}" ]; then
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
fi

if [ -z "$TOKEN" ]; then
    echo "Login failed against $BASE_URL — check the backend is up and the password (or, in OTP mode, DASHBOARD_SESSION_SECRET) is current." >&2
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
