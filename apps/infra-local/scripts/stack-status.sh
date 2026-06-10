#!/usr/bin/env bash
# Print a one-screen status of L1 + L2.
# Exit 0 if everything intended-up is up, 1 otherwise (handy for CI).

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

EXIT_CODE=0

echo "${C_BOLD}L1 — infra-local boxes${C_RESET}"
if boxlite ls 2>/dev/null | grep -q boxlite-local-postgres; then
  # boxlite ls outputs a unicode-bordered table; pluck name + status by
  # filtering for our box-name pattern then awking by the │ delimiter.
  boxlite ls 2>/dev/null \
    | grep boxlite-local- \
    | awk -F'│' '{
        # Trim leading/trailing whitespace on each field then print name + status
        gsub(/^[ \t]+|[ \t]+$/, "", $6); gsub(/^[ \t]+|[ \t]+$/, "", $4)
        printf "  %-26s %s\n", $6, $4
      }' || true
else
  warn "no L1 boxes running"
  EXIT_CODE=1
fi

echo
echo "${C_BOLD}L2 — native processes${C_RESET}"
printf "  %-10s %-8s %-8s %s\n" "COMP" "PID" "PORT" "STATE"
for comp in "${ALL_COMPONENTS[@]}"; do
  case "$comp" in
    api)        port=$PORT_API ;;
    runner)     port=$PORT_RUNNER ;;
    proxy)      port=$PORT_PROXY ;;
    dashboard)  port=$PORT_DASHBOARD ;;
  esac
  pid="$(component_pid "$comp" || true)"
  if [ -n "$pid" ]; then
    if port_listening "$port"; then
      printf "  %-10s %-8s %-8s %sup%s\n" "$comp" "$pid" "$port" "${C_GREEN}" "${C_RESET}"
    else
      printf "  %-10s %-8s %-8s %salive but not listening%s\n" "$comp" "$pid" "$port" "${C_YELLOW}" "${C_RESET}"
      EXIT_CODE=1
    fi
  else
    printf "  %-10s %-8s %-8s %sdown%s\n" "$comp" "-" "$port" "${C_DIM}" "${C_RESET}"
    EXIT_CODE=1
  fi
done

echo
echo "${C_BOLD}URLs${C_RESET}"
echo "  Dashboard:      http://localhost:${PORT_DASHBOARD}"
echo "  API:            http://localhost:${PORT_API}/api"
echo "  Dex (OIDC):     http://localhost:25556/dex"
echo "  Caddy (entry):  http://localhost:28080"
echo "  Jaeger:         http://localhost:26686"
echo "  pgAdmin:        http://localhost:25051"

echo
echo "${C_BOLD}Logs${C_RESET}: ${LOGS_DIR}/"

exit ${EXIT_CODE}
