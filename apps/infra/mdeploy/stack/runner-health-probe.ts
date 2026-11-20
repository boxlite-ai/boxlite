/** Probe the deployed listener using the identity recorded at boot. */
export const runnerHealthProbe = `runner_http_health() {
  local port=$1
  shift
  local env_file="\${BOXLITE_RUNNER_ENV_FILE:-/etc/boxlite/runner.env}"
  local name ca
  if [ -r "$env_file" ] && grep -q '^BOXLITE_PROTECTED_PROXY_RUNNER_ID=' "$env_file"; then
    name=$(sed -n 's/^BOXLITE_PROTECTED_PROXY_DNS_NAME=//p' "$env_file")
    ca=$(sed -n 's/^BOXLITE_PROTECTED_PROXY_CA_FILE=//p' "$env_file")
    [[ "$name" =~ ^[a-z0-9.-]+$ && -r "$ca" ]] || return 1
    curl "$@" --noproxy '*' --cacert "$ca" --resolve "$name:$port:127.0.0.1" "https://$name:$port/"
  else
    curl "$@" "http://127.0.0.1:$port/"
  fi
}
`
