#!/bin/sh
# Build everything and put the control plane into the dev Box "microcloud-cp".
# First run creates the Box (4 CPU / 8 GB, never auto-stops) and its public tunnel;
# later runs only replace the bundle and restart the process. The URL stays the same.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOX=microcloud-cp
REST=https://api.dev.boxlite.ai/v1
CLI_URL=https://dev.boxlite.ai/api
export BOXLITE_HOME=/tmp/blhome-dev

# Secrets come from .env.local (gitignored). BOXLITE_API_KEY there is the dev org key.
set -a; . "$ROOT/.env.local"; set +a
AUTH="Authorization: Bearer $BOXLITE_API_KEY"
bl() { boxlite --url "$CLI_URL" "$@"; }

echo "== build"
( cd "$ROOT/supervisor" && make build >/dev/null )
# SKIP_CLI=1 ships the last built CLI bundle (useful while the CLI is mid-change).
( cd "$ROOT" && pnpm --filter @microcloud/shared --filter @microcloud/control-plane build >/dev/null )
[ "${SKIP_CLI:-}" = 1 ] || ( cd "$ROOT" && pnpm --filter @microcloud/cli build >/dev/null )
[ "${SKIP_CONSOLE:-}" = 1 ] || "$ROOT/deploy/build-console.sh" >/dev/null
# The CLI is a single bundled file; ship it as a dependency-free npm package so
# `npm install -g <url>` works without the workspace.
PKG=$(mktemp -d)/package
mkdir -p "$PKG/dist"
cp "$ROOT/cli/dist/boxlite-app.cjs" "$PKG/dist/"
CLI_VERSION=$(node -p "require('$ROOT/cli/package.json').version")
cat > "$PKG/package.json" <<EOF
{"name":"boxlite-app","version":"$CLI_VERSION","bin":{"boxlite-app":"./dist/boxlite-app.cjs"},"engines":{"node":">=20"}}
EOF
( cd "$PKG/.." && COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$ROOT/cli/boxlite-app.tgz" package )

echo "== box"
if ! curl -fsS -H "$AUTH" "$REST/boxes/$BOX" >/dev/null 2>&1; then
  # cmd waits for the bundle, then runs it with the env file; it re-runs on every Box start.
  curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -X POST "$REST/boxes" -d @- >/dev/null <<EOF
{"name":"$BOX","image":"ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0","cpus":4,"memory_mib":8192,"disk_size_gb":10,
 "auto_stop":0,"auto_delete":0,"auto_resume":true,"network":{"inbound":{"mode":"enabled"}},
 "cmd":["sh","-c","while true; do if [ -f /home/boxlite/cp/control-plane/dist/server.mjs ]; then (cd /home/boxlite/cp/control-plane && set -a && . /home/boxlite/cp/cp.env && set +a && node dist/server.mjs >> /home/boxlite/cp/cp.log 2>&1); fi; sleep 2; done"]}
EOF
  sleep 3
fi
URL=$(curl -fsS -H "$AUTH" -H 'Content-Length: 0' -X POST "$REST/boxes/$BOX/network/tunnel?port=8080" | python3 -c 'import sys,json;print(json.load(sys.stdin)["uri"])')
echo "   $URL"

echo "== bundle"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/cp/control-plane/dist" "$STAGE/cp/supervisor/bin" "$STAGE/cp/agent" "$STAGE/cp/cli" "$STAGE/cp/console-dist"
cp -R "$ROOT/control-plane/dist/." "$STAGE/cp/control-plane/dist/"
cp "$ROOT/supervisor/bin/"supervisor-linux-* "$STAGE/cp/supervisor/bin/"
cp "$ROOT/agent/SKILL.md" "$ROOT/agent/prompt-template.md" "$STAGE/cp/agent/"
cp "$ROOT/cli/boxlite-app.tgz" "$STAGE/cp/cli/"
cp -R "$ROOT/console-dist/." "$STAGE/cp/console-dist/"
[ -f "$ROOT/.cp-admin-token" ] || head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$ROOT/.cp-admin-token"
[ -f "$ROOT/.cp-session-secret" ] || head -c 32 /dev/urandom | base64 | tr -d '/+=' > "$ROOT/.cp-session-secret"
umask 077
cat > "$STAGE/cp/cp.env" <<EOF
PORT=8080
PUBLIC_URL=$URL
CONSOLE_PORT=8081
CP_BOX_ID=$BOX
DATA_DIR=/home/boxlite/cp/data
ADMIN_TOKEN=$(cat "$ROOT/.cp-admin-token")
SESSION_SECRET=$(cat "$ROOT/.cp-session-secret")
BOXLITE_API_URL=$REST
BOXLITE_API_KEY=$BOXLITE_API_KEY
NEON_API_KEY=$NEON_API_KEY
NEON_ORG_ID=${NEON_ORG_ID:-org-patient-sky-92718703}
SV_BIN_DIR=/home/boxlite/cp/supervisor/bin
AGENT_MD_PATH=/home/boxlite/cp/agent/SKILL.md
CLI_TGZ_PATH=/home/boxlite/cp/cli/boxlite-app.tgz
CONSOLE_DIR=/home/boxlite/cp/console-dist
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID:-}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET:-}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}
EOF
( cd "$STAGE" && COPYFILE_DISABLE=1 tar --no-mac-metadata -czf bundle.tgz cp )
bl cp "$STAGE/bundle.tgz" "$BOX:/home/boxlite/bundle.tgz"
# Keep data/ across deploys; replace everything else, then restart the server process.
bl exec "$BOX" -- sh -c 'mkdir -p /home/boxlite/cp/data && cd /home/boxlite && rm -rf cp/console-dist && tar xzf bundle.tgz && chmod 600 cp/cp.env && pkill -f "^node dist/server.mjs" || true' || true
rm -rf "$STAGE"

echo "== wait"
i=0; until curl -fsS "$URL/healthz" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 30 ] && { echo "CP did not come up"; bl exec "$BOX" -- tail -40 /home/boxlite/cp/cp.log; exit 1; }; sleep 2; done
echo "live: $URL"
# The CP registers its other tunnels itself (console on 8081, one per app env on 10001+) and
# answers /console on the API origin with a redirect to the console's own origin.
echo "console: $(curl -s -o /dev/null -w '%{redirect_url}' "$URL/console/")"
