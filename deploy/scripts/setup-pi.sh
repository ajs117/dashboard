#!/usr/bin/env bash
# One-time (idempotent) provisioning for the Pi Zero 2W dashboard.
# Run ON THE PI as the `pi` user:  bash deploy/scripts/setup-pi.sh
#
# Assumes:
#   - Raspberry Pi OS (Bookworm). User is `pi` (uid 1000).
#   - A writable data location at /data (a separate partition is ideal; a plain
#     directory works too). The repo lives at /data/dashboard.
#   - You will add the printed deploy key to GitHub and edit /data/config.yaml.
#
# Re-run any time; each step checks before acting.
set -euo pipefail

REPO_DIR="${DASHBOARD_REPO:-/data/dashboard}"
CONFIG="${DASHBOARD_CONFIG:-/data/config.yaml}"
REPO_URL="${DASHBOARD_REPO_URL:-}"        # e.g. git@github.com:you/dashboard.git
DEPLOY_KEY="$HOME/.ssh/dashboard_deploy"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "Installing packages"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  git python3-venv python3-pip chromium-browser cage seatd unclutter

say "Preparing $REPO_DIR"
sudo mkdir -p "$(dirname "$REPO_DIR")"
sudo chown -R "$USER:$USER" "$(dirname "$REPO_DIR")"
if [ ! -d "$REPO_DIR/.git" ]; then
  if [ -n "$REPO_URL" ]; then
    git clone "$REPO_URL" "$REPO_DIR"
  elif [ "$HERE" != "$REPO_DIR" ]; then
    echo "No git checkout at $REPO_DIR. Set DASHBOARD_REPO_URL=... and re-run,"
    echo "or move this checkout to $REPO_DIR."
    exit 1
  fi
fi

say "Python venv + dependencies"
cd "$REPO_DIR/backend"
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r requirements.txt

say "Config"
if [ ! -f "$CONFIG" ]; then
  cp "$REPO_DIR/deploy/config.example.yaml" "$CONFIG"
  chmod 600 "$CONFIG"
  echo "Created $CONFIG from the example — EDIT IT (token, station, location)."
else
  echo "$CONFIG already exists, leaving it."
fi

say "GitHub deploy key (read-only pull)"
if [ ! -f "$DEPLOY_KEY" ]; then
  ssh-keygen -t ed25519 -N "" -f "$DEPLOY_KEY" -C "dashboard-deploy@$(hostname)"
fi
echo "Add THIS public key as a *read-only* Deploy Key on your GitHub repo:"
echo "  Settings -> Deploy keys -> Add deploy key"
echo "-------------------------------------------------------------"
cat "${DEPLOY_KEY}.pub"
echo "-------------------------------------------------------------"

say "Installing systemd units + sudoers"
sudo cp "$REPO_DIR"/deploy/systemd/dashboard-*.service /etc/systemd/system/
sudo cp "$REPO_DIR"/deploy/systemd/dashboard-update.timer /etc/systemd/system/
sudo install -m 0440 -o root -g root "$REPO_DIR/deploy/sudoers/dashboard" /etc/sudoers.d/dashboard
sudo systemctl daemon-reload
sudo systemctl enable --now dashboard-backend.service
sudo systemctl enable --now dashboard-kiosk.service
sudo systemctl enable --now dashboard-update.timer

say "Done"
cat <<EOF
Next steps:
  1. Paste the deploy key above into GitHub (read-only).
  2. Edit $CONFIG (Darwin token, station_crs, location, admin_token).
  3. Push location at runtime if needed:
       curl -X POST http://<pi>:8080/api/location \\
         -H "X-Admin-Token: <admin_token>" \\
         -H 'Content-Type: application/json' \\
         -d '{"lat":52.4823,"lon":-1.8990,"label":"Birmingham"}'
  4. When everything works, enable the read-only overlay FS for power-off safety:
       sudo raspi-config  ->  Performance  ->  Overlay File System  (enable)
     (/data stays writable for the app, config and updates.)
EOF
