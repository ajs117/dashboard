#!/usr/bin/env bash
# Git-poll auto-update. Run on a timer (see dashboard-update.timer).
# Pulls the latest commit; if anything changed, reinstalls deps (only when
# requirements changed) and restarts the services. Safe to run every couple of minutes.
set -euo pipefail

REPO="${DASHBOARD_REPO:-/data/dashboard}"
BRANCH="${DASHBOARD_BRANCH:-main}"
DEPLOY_KEY="${DASHBOARD_DEPLOY_KEY:-$HOME/.ssh/dashboard_deploy}"

export GIT_SSH_COMMAND="ssh -i ${DEPLOY_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

cd "$REPO"
git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/${BRANCH}")"
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0   # already up to date
fi

echo "[update] ${LOCAL:0:8} -> ${REMOTE:0:8}"
CHANGED="$(git diff --name-only "$LOCAL" "$REMOTE")"
git reset --hard "origin/${BRANCH}"

if echo "$CHANGED" | grep -q '^backend/requirements.txt$'; then
  echo "[update] requirements changed -> pip install"
  "$REPO/backend/.venv/bin/pip" install -q -r "$REPO/backend/requirements.txt"
fi

echo "[update] restarting services"
sudo systemctl restart dashboard-backend.service
# Reload the kiosk so the new frontend is shown (chromium restart is cheap enough here).
sudo systemctl restart dashboard-kiosk.service || true
echo "[update] done"
