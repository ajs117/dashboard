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
DEPLOYED_FILE="$REPO/.git/dashboard-deployed"

# The checkout can already point at the new commit after a failed pip install or service
# restart. Track the last commit that completed the whole activation sequence so the next
# timer run retries instead of incorrectly declaring the failed deployment up to date.
FIRST_ACTIVATION=false
if [ -f "$DEPLOYED_FILE" ]; then
  DEPLOYED="$(cat "$DEPLOYED_FILE")"
else
  # Existing installs have no marker yet. Run one full dependency sync + restart before
  # creating it; this also recovers if the updater itself was installed by a failed run.
  DEPLOYED="$LOCAL"
  FIRST_ACTIVATION=true
fi

if ! $FIRST_ACTIVATION && [ "$LOCAL" = "$REMOTE" ] && [ "$DEPLOYED" = "$REMOTE" ]; then
  exit 0   # already up to date
fi

echo "[update] ${DEPLOYED:0:8} -> ${REMOTE:0:8}"
CHANGED="$(git diff --name-only "$DEPLOYED" "$REMOTE")"
git reset --hard "origin/${BRANCH}"

if $FIRST_ACTIVATION || echo "$CHANGED" | grep -q '^backend/requirements.txt$'; then
  echo "[update] requirements changed -> pip install"
  "$REPO/backend/.venv/bin/pip" install -q -r "$REPO/backend/requirements.txt"
fi

echo "[update] restarting services"
sudo systemctl restart dashboard-backend.service
# Reload the kiosk so the new frontend is shown (chromium restart is cheap enough here).
sudo systemctl restart dashboard-kiosk.service || true
printf '%s\n' "$REMOTE" > "${DEPLOYED_FILE}.tmp"
mv "${DEPLOYED_FILE}.tmp" "$DEPLOYED_FILE"
echo "[update] done"
