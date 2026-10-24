#!/bin/sh
# Build the BoxLite dashboard as the standalone Apps console and put it in console-dist/,
# which the control plane serves at /console/ (CONSOLE_DIR, default ../console-dist from control-plane/).
#
# The dashboard lives in the boxlite repo (branch micro-cloud-console). Point DASHBOARD_DIR at its
# JS workspace root (the directory holding nx.json and dashboard/).
#
#   VITE_APPS_API_URL     the console API the Apps screens call (the control plane's /console/api)
#   DASHBOARD_BASE_PATH   asset base and router basename (/console/)
#   VITE_ENABLE_MOCKING   MSW keeps serving the rest of the dashboard shell (config, organization);
#                         it passes /console/api through untouched. VITE_API_URL points that mock at a
#                         same-origin path that does not exist, so nothing leaks to a real API.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DASHBOARD_DIR=${DASHBOARD_DIR:-$ROOT/../boxlite_repo/boxlite-micro-cloud-app/apps}
DASHBOARD_DIR=$(cd "$DASHBOARD_DIR" && pwd)
OUT=$DASHBOARD_DIR/dist/apps/dashboard
DEST=$ROOT/console-dist

echo "== build dashboard ($DASHBOARD_DIR, branch $(git -C "$DASHBOARD_DIR" rev-parse --abbrev-ref HEAD))"
cd "$DASHBOARD_DIR"
VITE_ENABLE_MOCKING=true \
VITE_APPS_API_URL=/console/api \
VITE_API_URL=/console/mock-api \
VITE_BASE_API_URL=/console/mock-api \
DASHBOARD_BASE_PATH=/console/ \
  npx nx run dashboard:build --configuration=development --skip-nx-cache

# The build drops the MSW worker; the shell still needs it.
cp "$DASHBOARD_DIR/dashboard/public/mockServiceWorker.js" "$OUT/"

rm -rf "$DEST"
cp -R "$OUT" "$DEST"
rm -f "$DEST/CLAUDE.md" "$DEST/README.md"
echo "== done: $DEST ($(du -sh "$DEST" | cut -f1)); serve it with the control plane at <cp>/console/"
