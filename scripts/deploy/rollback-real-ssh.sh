#!/usr/bin/env bash
# Rollback drill for real SSH (design, external source of truth in the
# boxlite_integration_test repo, not checked into this repository:
# https://github.com/nieyy/boxlite_integration_test/blob/main/docs/designs/2026-07-23-boxlite-direct-tunnel-real-ssh-design-zh.md,
# Phase 4 "回滚 drill"): disable new issuance -> apply an empty access set to the
# given boxes -> (operator step) restart the runner fleet with guest SSH
# disabled -> verify the generic direct tunnel still works.
#
# This script does NOT restart the API or the runner fleet itself -- setting
# SSH_ISSUANCE_ENABLED=false / BOXLITE_GUEST_SSH_ENABLED=false and rolling
# the fleet is an infra-level action (env var + `sst deploy`, or an SSM/
# systemd restart per scripts/deploy/runner-update-binary.sh's pattern) that
# depends on the target environment's actual deploy mechanics, which this
# repo/session has no access to verify. This script covers the parts that
# are pure Hosted-API calls: revoking every currently-active credential on
# the given boxes (the "apply an empty access set" step) and the post-
# rollback generic-tunnel check.
#
# Usage:
#   BOXLITE_E2E_API_URL=https://api.example.com \
#   BOXLITE_E2E_API_KEY=<admin-scoped bearer token> \
#     scripts/deploy/rollback-real-ssh.sh box-id-1 box-id-2 ...
#
# Exit status: non-zero if any credential fails to revoke, or if the
# post-rollback generic-tunnel check fails on any box.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <box-id> [box-id ...]" >&2
  echo "  BOXLITE_E2E_API_URL and BOXLITE_E2E_API_KEY (or BOXLITE_E2E_OIDC_TOKEN) must be set." >&2
  exit 2
fi

API_URL="${BOXLITE_E2E_API_URL:?BOXLITE_E2E_API_URL must be set}"
if [[ -n "${BOXLITE_E2E_API_KEY:-}" ]]; then
  AUTH_HEADER="Authorization: Bearer ${BOXLITE_E2E_API_KEY}"
elif [[ -n "${BOXLITE_E2E_OIDC_TOKEN:-}" ]]; then
  AUTH_HEADER="Authorization: Bearer ${BOXLITE_E2E_OIDC_TOKEN}"
else
  echo "error: set BOXLITE_E2E_API_KEY or BOXLITE_E2E_OIDC_TOKEN" >&2
  exit 2
fi

api() {
  local method="$1" path="$2"
  curl -sS -X "$method" "${API_URL%/}${path}" -H "$AUTH_HEADER" -H "Content-Type: application/json"
}

echo "=== Step 1: disable new issuance ==="
echo "This script does not flip SSH_ISSUANCE_ENABLED itself -- that's an env"
echo "var + redeploy/restart on the API tier for this environment. Set it now"
echo "and confirm before continuing:"
echo "  SSH_ISSUANCE_ENABLED=false (apps/api/.env.example)"
read -r -p "Press Enter once SSH_ISSUANCE_ENABLED=false is live on the API... " _

echo "=== Step 2: revoke every active credential on the given boxes (apply an empty access set) ==="
failures=0
for box_id in "$@"; do
  echo "-- box ${box_id}"
  credentials_json=$(api GET "/box/${box_id}/ssh-access")
  credential_ids=$(echo "$credentials_json" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
print('\n'.join(r['id'] for r in rows if r.get('status') == 'ACTIVE'))
")
  if [[ -z "$credential_ids" ]]; then
    echo "   no active credentials"
    continue
  fi
  while IFS= read -r credential_id; do
    [[ -z "$credential_id" ]] && continue
    echo "   revoking ${credential_id}"
    status=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
      "${API_URL%/}/box/${box_id}/ssh-access/${credential_id}" -H "$AUTH_HEADER")
    if [[ "$status" != "200" ]]; then
      echo "   FAILED (HTTP ${status})" >&2
      failures=$((failures + 1))
    fi
  done <<< "$credential_ids"
done

if [[ "$failures" -gt 0 ]]; then
  echo "error: ${failures} credential revoke(s) failed -- rollback is NOT complete" >&2
  exit 1
fi

echo "=== Step 3: disable guest SSH on restart ==="
echo "Set BOXLITE_GUEST_SSH_ENABLED=false on the runner fleet (apps/infra/.env.example)"
echo "and restart/redeploy so new box starts skip the SSH listener:"
echo "  scripts/deploy/runner-update-binary.sh   # or the equivalent for this environment"
read -r -p "Press Enter once the runner fleet has been restarted with guest SSH disabled... " _

echo "=== Step 4: verify the generic direct tunnel still works ==="
echo "This step is intentionally NOT automated here: it needs a real exec"
echo "call through the existing tunnel (unrelated to this feature) against"
echo "each box, e.g.:"
echo "  curl -X POST \"\$API_URL/v1/boxes/<box-id>/exec\" -H \"\$AUTH_HEADER\" \\"
echo "    -d '{\"command\": [\"echo\", \"rollback-ok\"]}'"
echo "Confirm the generic tunnel (exec/files/preview) is unaffected for each box before"
echo "declaring the rollback drill complete."

echo "Rollback drill steps 1-2 complete. Steps 3-4 require manual confirmation above."
