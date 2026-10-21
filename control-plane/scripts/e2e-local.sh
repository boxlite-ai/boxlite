#!/usr/bin/env bash
# Local end-to-end smoke test of the control plane: no BoxLite Box and no Neon project is created.
# Starts the CP on $PORT (default 8787) with a throwaway DATA_DIR, then exercises
# POST /v1/apps → plan → upload → apply (no [database], no Box) → status/spec/context/events.
# Steps that need real infrastructure (deploy into a Box, database) are skipped and say so.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
BASE="http://localhost:${PORT}"
DATA_DIR="$(mktemp -d -t cp-e2e)"
ADMIN_TOKEN="e2e-admin-$RANDOM$RANDOM"
APP="e2e$RANDOM"
WORK="$(mktemp -d -t cp-e2e-work)"
LOG="$DATA_DIR/cp.log"

cleanup() {
  [[ -n "${CP_PID:-}" ]] && kill "$CP_PID" 2>/dev/null || true
  rm -rf "$DATA_DIR" "$WORK"
}
trap cleanup EXIT

if [[ -f dist/server.mjs ]]; then RUN=(node dist/server.mjs); else RUN=(npx tsx src/main.ts); fi
# Empty platform keys: anything that would reach BoxLite or Neon fails fast with `unavailable`.
env PORT="$PORT" DATA_DIR="$DATA_DIR" ADMIN_TOKEN="$ADMIN_TOKEN" PUBLIC_URL="$BASE" \
  BOXLITE_API_KEY= NEON_API_KEY= NEON_ORG_ID= SESSION_SECRET=e2e \
  "${RUN[@]}" >"$LOG" 2>&1 &
CP_PID=$!

for _ in $(seq 1 50); do
  curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "$BASE/healthz" >/dev/null || { echo "CP did not start:"; cat "$LOG"; exit 1; }

# json <expr>: evaluates a property path on stdin JSON, e.g. json .key
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=new Function("o","return o"+process.argv[1])(o);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
ok() { printf '  ok  %s\n' "$*"; }
skip() { printf '  --  skipped: %s\n' "$*"; }

echo "control plane on $BASE (data $DATA_DIR)"

# 1. create the app (admin)
CREATED="$(curl -fsS -X POST "$BASE/v1/apps" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d "{\"name\":\"$APP\"}")"
KEY="$(echo "$CREATED" | json .key)"
[[ "$KEY" =~ ^bxl_app_[a-z2-7]{32}$ ]] || { echo "bad key: $KEY"; exit 1; }
ok "POST /v1/apps → $APP, key …${KEY: -4}"
AUTH=(-H "authorization: Bearer $KEY")

# 2. a tiny project (no [database], so apply needs no Neon)
cat >"$WORK/boxlite.toml" <<EOF
name = "$APP"

[runtime]
image = "node"
size = "nano"

[[service]]
name = "web"
command = "node server.js"
port = 3000

[variables]
GREETING = "hello"
EOF
echo 'require("http").createServer((q,s)=>s.end(process.env.GREETING)).listen(process.env.PORT)' >"$WORK/server.js"
TOML_JSON="$(node -e 'console.log(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$WORK/boxlite.toml")"

# 3. plan
PLAN="$(curl -fsS -X POST "$BASE/v1/apps/$APP/envs/main/plan" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"manifest\":$TOML_JSON,\"base_version\":0,\"migrations\":[]}")"
[[ "$(echo "$PLAN" | json .errors.length)" == 0 ]] || { echo "plan errors: $PLAN"; exit 1; }
ok "plan: $(echo "$PLAN" | json '.changes.map(c=>c.kind+" "+c.path).join(", ")')"

# 4. upload: manifest → missing → PUT → complete; a second upload must find nothing missing
file_entry() { local p="$1"; printf '{"path":"%s","size":%s,"mode":420,"sha256":"%s"}' "$p" "$(wc -c <"$WORK/$p" | tr -d ' ')" "$(shasum -a 256 "$WORK/$p" | cut -d' ' -f1)"; }
MANIFEST="[$(file_entry boxlite.toml),$(file_entry server.js)]"
UP="$(curl -fsS -X POST "$BASE/v1/apps/$APP/uploads" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"manifest\":$MANIFEST}")"
UP_ID="$(echo "$UP" | json .upload_id)"
for p in boxlite.toml server.js; do
  SHA="$(shasum -a 256 "$WORK/$p" | cut -d' ' -f1)"
  curl -fsS -X PUT "$BASE/v1/apps/$APP/uploads/$UP_ID/files/$SHA" "${AUTH[@]}" -H 'content-type: application/octet-stream' --data-binary "@$WORK/$p" >/dev/null
done
SNAP="$(curl -fsS -X POST "$BASE/v1/apps/$APP/uploads/$UP_ID/complete" "${AUTH[@]}" | json .snapshot_id)"
ok "upload → $SNAP"
AGAIN="$(curl -fsS -X POST "$BASE/v1/apps/$APP/uploads" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"manifest\":$MANIFEST}" | json .missing.length)"
[[ "$AGAIN" == 0 ]] || { echo "dedupe failed"; exit 1; }
ok "re-upload dedupes (0 missing)"

# 5. apply (config only: no Box yet, no database) → live without touching BoxLite
DEP="$(curl -fsS -X POST "$BASE/v1/apps/$APP/envs/main/deployments" "${AUTH[@]}" -H 'content-type: application/json' -H 'idempotency-key: e2e-1' \
  -d "{\"kind\":\"apply\",\"manifest\":$TOML_JSON,\"base_version\":0,\"migrations\":[]}")"
N="$(echo "$DEP" | json .number)"
EVENTS="$(curl -fsS -N --max-time 20 "$BASE/v1/apps/$APP/envs/main/deployments/$N/events" "${AUTH[@]}")"
echo "$EVENTS" | grep -q '^event: done' || { echo "no done event: $EVENTS"; exit 1; }
STATUS="$(curl -fsS "$BASE/v1/apps/$APP/envs/main/deployments/$N" "${AUTH[@]}" | json .status)"
[[ "$STATUS" == live ]] || { echo "apply status $STATUS"; curl -fsS "$BASE/v1/apps/$APP/envs/main/deployments/$N" "${AUTH[@]}"; exit 1; }
ok "apply #$N → live; SSE ended with done"

SPEC="$(curl -fsS "$BASE/v1/apps/$APP/envs/main/spec" "${AUTH[@]}")"
[[ "$(echo "$SPEC" | json .variables.GREETING)" == hello ]] || { echo "spec: $SPEC"; exit 1; }
ok "spec v$(echo "$SPEC" | json .version) has variables.GREETING"

# 6. stale base is refused
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/apps/$APP/envs/main/deployments" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"kind\":\"apply\",\"manifest\":$TOML_JSON,\"base_version\":0,\"migrations\":[]}")"
[[ "$CODE" == 409 ]] || { echo "expected 409 stale_base, got $CODE"; exit 1; }
ok "stale base_version → 409"

# 7. reads
curl -fsS "$BASE/v1/apps/$APP" "${AUTH[@]}" | json '.envs[0].status' | grep -q live && ok "GET /v1/apps/$APP → main live"
curl -fsS "$BASE/v1/apps/me" "${AUTH[@]}" | json .name | grep -qx "$APP" && ok "GET /v1/apps/me resolves the key's app"
curl -fsS "$BASE/v1/apps/$APP/context" "${AUTH[@]}" | grep -q "^# $APP" && ok "context (markdown)"
curl -fsS "$BASE/v1/apps/$APP/activity" "${AUTH[@]}" | json .length >/dev/null && ok "activity"
curl -fsS "$BASE/" | grep -q "$APP" && ok "status page lists the app"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/$APP/")"
[[ "$CODE" == 401 ]] && ok "private app without cookie → 401"

skip "deploy into a Box (needs BOXLITE_API_KEY and a reachable PUBLIC_URL)"
skip "[database] apply / db sql (needs NEON_API_KEY and NEON_ORG_ID)"
echo "e2e-local passed"
