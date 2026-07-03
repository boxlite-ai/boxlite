#!/usr/bin/env bash
set -euo pipefail

{{API_KEY_SH}}
BOXLITE_REST_URL="${BOXLITE_REST_URL:-{{REST_API_URL}}}"
auth=(-H "Authorization: Bearer ${BOXLITE_API_KEY}")
json=(-H "Content-Type: application/json")
name="sdk-quickstart-rest-$(date +%s)"

box_id="$(
  curl -fsS -X POST "${BOXLITE_REST_URL}/v1/boxes" \
    "${auth[@]}" "${json[@]}" \
    -d "{\"name\":\"${name}\",\"image\":\"ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3\"}" \
    | jq -r '.box_id'
)"
trap 'curl -fsS -X DELETE "${BOXLITE_REST_URL}/v1/boxes/${box_id}?force=true" "${auth[@]}" >/dev/null || true' EXIT

curl -fsS -X POST "${BOXLITE_REST_URL}/v1/boxes/${box_id}/start" "${auth[@]}" >/dev/null

exec_id="$(
  curl -fsS -X POST "${BOXLITE_REST_URL}/v1/boxes/${box_id}/exec" \
    "${auth[@]}" "${json[@]}" \
    -d '{"command":"echo","args":["Hello from BoxLite REST"]}' \
    | jq -r '.execution_id'
)"

curl -fsS "${BOXLITE_REST_URL}/v1/boxes/${box_id}/executions/${exec_id}" "${auth[@]}" | jq
