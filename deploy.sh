#!/usr/bin/env bash
# Safe deploy for the MoneyPenny dashboard.
#
# Replaces the old `git pull && npm run build && pm2 restart` chain, which
# silently deployed stale code: when `git pull` aborted on a locally-modified
# tracked file, `&&` still let the build run, so it rebuilt the OLD commit and
# reported success.
#
# Usage:  cd /opt/moneypenny && ./deploy.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://localhost:8000}"

rule() { printf '%s\n' "═══════════════════════════════════════════════════════════════"; }
step() { printf '\n→ %s\n' "$1"; }
fail() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

rule
echo "  MoneyPenny Dashboard — Safe Deploy"
rule

cd "$REPO_DIR"

step "Checking working tree..."
# Only TRACKED modifications block a pull. Untracked files are reported but
# harmless, so they must not wedge every future deploy.
if ! git diff --quiet HEAD -- 2>/dev/null; then
    echo "  Locally modified tracked files — a pull would abort:"
    git status --short -- | grep -vE '^\?\?' || true
    echo
    echo "  Commit, stash, or discard them first. To discard one file:"
    echo "    git checkout -- <path>"
    fail "Refusing to deploy with a dirty tree (this is what silently deployed stale code before)."
fi
UNTRACKED="$(git ls-files --others --exclude-standard | head -20)"
if [ -n "$UNTRACKED" ]; then
    echo "  Untracked files present (not a problem, listing for awareness):"
    printf '    %s\n' $UNTRACKED
fi

BEFORE="$(git rev-parse HEAD)"

step "Pulling latest..."
git pull --ff-only
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
    echo "  Already up to date at $(git rev-parse --short HEAD) — rebuilding anyway."
else
    echo "  $(git rev-parse --short "$BEFORE") → $(git rev-parse --short "$AFTER")"
    git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/    /'
fi

step "Building frontend..."
cd "$REPO_DIR/frontend"
NODE_OPTIONS="--max-old-space-size=1024" npm run build
cd "$REPO_DIR"

step "Restarting backend..."
pm2 restart backend --update-env >/dev/null
echo "  backend restarted"

step "Reloading nginx..."
sudo systemctl reload nginx
echo "  nginx reloaded"

step "Verifying..."
# /api/health is the only auth-exempt JSON endpoint (see AUTH_EXEMPT_PREFIXES).
# The old script polled /api/auth/verify, which answers 401 without a token, so
# `curl -sf` always reported the backend down even when it was healthy.
OK=0
for i in $(seq 1 30); do
    if curl -sf -o /dev/null "$BASE_URL/api/health"; then OK=1; break; fi
    sleep 2
done
[ "$OK" = 1 ] && echo "  ✓ Backend responding (/api/health)" \
              || { pm2 logs backend --lines 30 --nostream || true; fail "Backend not responding after 60s"; }

curl -sf -o /dev/null http://localhost/ && echo "  ✓ Nginx serving" \
                                        || fail "Nginx not serving"

ROSTER="$(curl -sf "$BASE_URL/api/health" 2>/dev/null || true)"
[ -n "$ROSTER" ] && echo "  ✓ Health payload: ${ROSTER:0:120}"

echo "  deployed commit: $(git rev-parse --short HEAD)"

rule
echo "  ✅ Deploy complete"
rule
