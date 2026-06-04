#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 02_setup_server.sh — Bootstrap a fresh Ubuntu 22.04 EC2 instance
#
# Run on the EC2 instance (NOT your laptop):
#   sudo ./02_setup_server.sh
#
# Installs: Python 3.11 + venv, Node.js 20, Nginx, Git, PM2.
# Configures UFW to allow ports 22 / 80 / 443 / 8000 (AWS SG is the outer
# firewall; UFW is defense-in-depth).
# Creates /opt/moneypenny owned by ubuntu so the deploy script (which runs
# unprivileged) can write to it.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "✖ Must run as root (sudo)." >&2
  exit 1
fi

APP_DIR=/opt/moneypenny
APP_USER=ubuntu

echo "▶ apt update / upgrade…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y -o Dpkg::Options::="--force-confnew"

echo "▶ Installing base packages…"
apt-get install -y \
  software-properties-common \
  build-essential \
  curl wget git ca-certificates gnupg lsb-release \
  nginx ufw unzip

# ── Python 3.11 ─────────────────────────────────────────────────────────────
echo "▶ Installing Python 3.11 (deadsnakes PPA)…"
add-apt-repository -y ppa:deadsnakes/ppa
apt-get update -y
apt-get install -y python3.11 python3.11-venv python3.11-dev python3-pip
python3.11 --version

# ── Node.js 20 (NodeSource) ─────────────────────────────────────────────────
echo "▶ Installing Node.js 20…"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

# ── PM2 ─────────────────────────────────────────────────────────────────────
echo "▶ Installing PM2 (process manager)…"
npm install -g pm2
pm2 --version

# ── UFW (defense-in-depth; the AWS SG is the real perimeter) ────────────────
echo "▶ Configuring UFW firewall…"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8000/tcp
ufw --force enable
ufw status

# ── App directory ───────────────────────────────────────────────────────────
echo "▶ Creating ${APP_DIR}…"
mkdir -p "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# Drop the default nginx welcome page so it doesn't shadow our config later
rm -f /etc/nginx/sites-enabled/default

systemctl enable nginx
systemctl start nginx

echo
echo "═══════════════════════════════════════════════════════════════"
echo " ✓ Server bootstrap complete"
echo "═══════════════════════════════════════════════════════════════"
echo " Python    : $(python3.11 --version)"
echo " Node      : $(node --version)"
echo " npm       : $(npm --version)"
echo " PM2       : $(pm2 --version)"
echo " Nginx     : $(nginx -v 2>&1)"
echo " App dir   : ${APP_DIR} (owned by ${APP_USER})"
echo
echo " Next: run 03_deploy_app.sh (as ubuntu, NOT root) — see README.md"
echo "═══════════════════════════════════════════════════════════════"
