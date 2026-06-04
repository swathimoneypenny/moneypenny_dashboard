#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 03_deploy_app.sh — Deploy the MoneyPenny Dashboard onto a prepared EC2 box
#
# Run on the EC2 instance (NOT your laptop), AS the ubuntu user, with sudo
# rights for the steps that need root (nginx config + pm2 startup):
#   ./03_deploy_app.sh
#
# Expects 02_setup_server.sh to have already run. Idempotent — re-run after
# pulling new code to redeploy.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="https://github.com/swathimoneypenny/moneypenny_dashboard.git"
APP_DIR=/opt/moneypenny
BACKEND_DIR="${APP_DIR}/backend"
FRONTEND_DIR="${APP_DIR}/frontend"
NGINX_CONF_SRC="${APP_DIR}/deploy/aws/nginx.conf"
NGINX_CONF_DEST=/etc/nginx/sites-available/moneypenny
NGINX_LINK=/etc/nginx/sites-enabled/moneypenny

if [[ $EUID -eq 0 ]]; then
  echo "✖ Do NOT run this script as root. Run as 'ubuntu' — it will sudo when it needs to." >&2
  exit 1
fi

# ── Pull / refresh the repo ─────────────────────────────────────────────────
if [[ -d "${APP_DIR}/.git" ]]; then
  echo "▶ Repo already cloned — pulling latest…"
  git -C "${APP_DIR}" fetch --depth 1 origin main
  git -C "${APP_DIR}" reset --hard origin/main
else
  echo "▶ Cloning repo…"
  # In case ${APP_DIR} exists but is empty (created by setup script):
  sudo chown -R "$(whoami):$(whoami)" "${APP_DIR}"
  if [[ -z "$(ls -A "${APP_DIR}" 2>/dev/null)" ]]; then
    git clone --depth 1 "${REPO_URL}" "${APP_DIR}"
  else
    # Non-empty but no .git — clone into a tmp dir then move .git in
    TMP=$(mktemp -d)
    git clone --depth 1 "${REPO_URL}" "${TMP}/repo"
    cp -rT "${TMP}/repo" "${APP_DIR}"
    rm -rf "${TMP}"
  fi
fi

# ── Backend ─────────────────────────────────────────────────────────────────
echo "▶ Backend: venv + pip install…"
cd "${BACKEND_DIR}"
if [[ ! -d venv ]]; then
  python3.11 -m venv venv
fi
# Upgrade pip in the venv (faster wheels, better resolver)
venv/bin/pip install --upgrade pip wheel
venv/bin/pip install -r requirements.txt

if [[ ! -f "${BACKEND_DIR}/.env" ]]; then
  echo "▶ Backend .env missing — seeding from .env.example"
  cp "${APP_DIR}/deploy/aws/.env.example" "${BACKEND_DIR}/.env"
  chmod 600 "${BACKEND_DIR}/.env"
  echo "  ⚠ EDIT ${BACKEND_DIR}/.env BEFORE THE APP WILL WORK"
fi

# ── Frontend (build static bundle) ──────────────────────────────────────────
echo "▶ Frontend: npm install + build…"
cd "${FRONTEND_DIR}"
npm ci || npm install
npm run build
echo "  · dist/ size: $(du -sh dist | cut -f1)"

# ── Nginx config ────────────────────────────────────────────────────────────
echo "▶ Installing nginx site config…"
sudo cp "${NGINX_CONF_SRC}" "${NGINX_CONF_DEST}"
sudo ln -sf "${NGINX_CONF_DEST}" "${NGINX_LINK}"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# ── PM2: keep backend alive ─────────────────────────────────────────────────
echo "▶ (Re)starting backend under PM2…"
cd "${BACKEND_DIR}"
# `pm2 startOrReload` doesn't accept an inline command string; describe the
# process via a JS module instead so it survives `pm2 save` / reboot cleanly.
cat > "${BACKEND_DIR}/pm2.config.cjs" <<'PM2'
module.exports = {
  apps: [{
    name: "backend",
    cwd: "/opt/moneypenny/backend",
    script: "venv/bin/uvicorn",
    args: "main:app --host 0.0.0.0 --port 8000",
    interpreter: "none",
    env: { PYTHONUNBUFFERED: "1" },
    max_restarts: 20,
    restart_delay: 4000,
    autorestart: true,
  }]
};
PM2
pm2 startOrReload "${BACKEND_DIR}/pm2.config.cjs"
pm2 save

# Install pm2 systemd unit so the process survives reboots. The first run
# prints a sudo command the user (or this script) must execute; we run it
# automatically.
STARTUP_CMD=$(pm2 startup systemd -u "$(whoami)" --hp "${HOME}" | tail -n 1 || true)
if [[ "${STARTUP_CMD}" == sudo* ]]; then
  echo "▶ Enabling PM2 systemd unit…"
  eval "${STARTUP_CMD}"
fi

echo
echo "═══════════════════════════════════════════════════════════════"
echo " ✓ Deployment complete"
echo "═══════════════════════════════════════════════════════════════"
echo " Backend  : http://<public-ip>:8000 (proxied by nginx)"
echo " Frontend : http://<public-ip>/   (nginx serves dist/)"
echo
echo " Useful commands:"
echo "   pm2 status                    — process state"
echo "   pm2 logs backend              — tail backend logs"
echo "   pm2 restart backend           — restart after .env edit"
echo "   sudo systemctl reload nginx   — apply nginx config changes"
echo "   sudo tail -f /var/log/nginx/error.log"
echo "═══════════════════════════════════════════════════════════════"
