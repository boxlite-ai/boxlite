/** Cloud boot policy, independent of runner/SDK package identity. */
export const CLOUD_RUNNER_KERNEL = {
  url: 'https://github.com/boxlite-ai/libkrunfw/releases/download/v5.4.0/libkrunfw-kernel-dind-x86_64.bin',
  sha256: '3c6cfc8015a1ba05cebabecd37967d665f2a0f81424b69f8d43d6e87feaceb92',
}

/** Shared by first boot, AWS commands and GCP policy enforcement. */
export const kernelDeployment = (kernel = CLOUD_RUNNER_KERNEL, port = 3003) => {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('runner kernel health port must be a whole number from 1 to 65535')
  }
  if (
    !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9/_.-]+$/.test(kernel.url) ||
    !/^[0-9a-f]{64}$/.test(kernel.sha256)
  ) {
    throw new Error('runner kernel requires an HTTPS asset URL and a lowercase SHA256')
  }
  const setup = `KERNEL_PATH='/opt/boxlite/kernels/${kernel.sha256}/kernel.bin'
KERNEL_ENV='/etc/boxlite/kernel.env'
KERNEL_DROPIN='/etc/systemd/system/boxlite-runner.service.d/kernel.conf'
KERNEL_HEALTH='http://127.0.0.1:${port}/'

lock_runner_kernel() {
  exec 9>/run/lock/boxlite-runner-kernel.lock || return 1
  flock -n 9 || { echo 'runner kernel update already in progress; retry later' >&2; return 1; }
}

runner_kernel_bytes_match() {
  [ -f "$KERNEL_PATH" ] && printf '%s  %s\\n' '${kernel.sha256}' "$KERNEL_PATH" | sha256sum --check --status
}

runner_kernel_configuration_matches() {
  runner_kernel_bytes_match &&
    [ "$(cat "$KERNEL_ENV" 2>/dev/null)" = "BOXLITE_KERNEL_PATH=$KERNEL_PATH" ] &&
    [ "$(cat "$KERNEL_DROPIN" 2>/dev/null)" = "$(printf '[Service]\\nEnvironmentFile=%s' "$KERNEL_ENV")" ] &&
    systemctl is-active --quiet boxlite-runner
}

runner_kernel_healthy() {
  local response main_pid listeners
  # Startup wrappers exec the runner, so MainPID owns its HTTP listener.
  main_pid=$(systemctl show --property=MainPID --value boxlite-runner) || return 1
  [ "$main_pid" -gt 0 ] || return 1
  tr '\\0' '\\n' < "/proc/$main_pid/environ" | grep -qxF "BOXLITE_KERNEL_PATH=$KERNEL_PATH" || return 1
  listeners=$(ss -H -ltnp 'sport = :${port}') || return 1
  [[ "$listeners" == *"pid=$main_pid,"* ]] || return 1
  response=$(curl --fail --silent --show-error --max-time 3 --write-out '\\n%{http_code}' "$KERNEL_HEALTH") || return 1
  [ "\${response##*$'\\n'}" = 200 ] &&
    [ -n "$(printf '%s\\n' "$response" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')" ]
}

runner_kernel_matches() {
  runner_kernel_configuration_matches && runner_kernel_healthy
}

wait_for_runner_kernel() {
  for _ in $(seq 1 30); do
    runner_kernel_healthy && return 0
    sleep 2
  done
  return 1
}

fetch_runner_kernel() {
  if runner_kernel_bytes_match; then return 0; fi
  mkdir -p "$(dirname "$KERNEL_PATH")" || return 1
  local partial
  partial=$(mktemp "$(dirname "$KERNEL_PATH")/.download.XXXXXX") || return 1
  if timeout 120 curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \\
      --connect-timeout 10 --max-time 120 \\
      --retry 5 --retry-delay 2 --retry-connrefused \\
      '${kernel.url}' -o "$partial" &&
    printf '%s  %s\\n' '${kernel.sha256}' "$partial" | sha256sum --check --status &&
    chmod 0444 "$partial" && mv -f "$partial" "$KERNEL_PATH"; then
    echo 'runner kernel SHA256 verified: ${kernel.sha256}'
  else
    rm -f "$partial"
    echo 'runner kernel download or SHA256 verification failed' >&2
    return 1
  fi
}

write_runner_kernel_config() {
  mkdir -p "$(dirname "$KERNEL_ENV")" "$(dirname "$KERNEL_DROPIN")" &&
    printf 'BOXLITE_KERNEL_PATH=%s\\n' "$KERNEL_PATH" > "$KERNEL_ENV.next" &&
    chmod 0644 "$KERNEL_ENV.next" && mv -f "$KERNEL_ENV.next" "$KERNEL_ENV" &&
    printf '[Service]\\nEnvironmentFile=%s\\n' "$KERNEL_ENV" > "$KERNEL_DROPIN.next" &&
    chmod 0644 "$KERNEL_DROPIN.next" && mv -f "$KERNEL_DROPIN.next" "$KERNEL_DROPIN"
}

install_runner_kernel() {
  fetch_runner_kernel && write_runner_kernel_config
}
`
  return {
    setup,
    install: `${setup}\n(\nlock_runner_kernel || exit 1\ninstall_runner_kernel\n)\n`,
    enforce: `set -euo pipefail
(
${setup}
# First boot installs its own kernel before enabling or starting the service.
if ! systemctl is-enabled --quiet boxlite-runner 2>/dev/null &&
    ! systemctl is-active --quiet boxlite-runner; then exit 0; fi
lock_runner_kernel
if runner_kernel_matches; then echo 'runner kernel already current'; exit 0; fi
# A failed download must not stop the serving runner or change its configuration.
fetch_runner_kernel
KERNEL_BACKUP=$(mktemp -d)
for file in "$KERNEL_ENV" "$KERNEL_DROPIN"; do
  if [ -f "$file" ]; then cp -a "$file" "$KERNEL_BACKUP/$(basename "$file")"; fi
done
if write_runner_kernel_config && systemctl daemon-reload &&
    systemctl restart boxlite-runner && runner_kernel_configuration_matches && wait_for_runner_kernel; then
  rm -rf "$KERNEL_BACKUP"
else
  KERNEL_RESTORED=true
  for file in "$KERNEL_ENV" "$KERNEL_DROPIN"; do
    if [ -f "$KERNEL_BACKUP/$(basename "$file")" ]; then
      cp -a "$KERNEL_BACKUP/$(basename "$file")" "$file" || {
        echo "runner kernel rollback could not restore $file" >&2; KERNEL_RESTORED=false;
      }
    else
      rm -f "$file" || {
        echo "runner kernel rollback could not remove $file" >&2; KERNEL_RESTORED=false;
      }
    fi
  done
  systemctl daemon-reload || {
    echo 'runner kernel rollback daemon-reload failed' >&2; KERNEL_RESTORED=false;
  }
  systemctl restart boxlite-runner || {
    echo 'runner kernel rollback restart failed' >&2; KERNEL_RESTORED=false;
  }
  if [ "$KERNEL_RESTORED" = true ]; then
    rm -rf "$KERNEL_BACKUP"
    echo 'runner kernel activation failed; restored previous configuration' >&2
  else
    echo "runner kernel rollback incomplete; backup retained at $KERNEL_BACKUP" >&2
  fi
  exit 1
fi
)
`,
  }
}
