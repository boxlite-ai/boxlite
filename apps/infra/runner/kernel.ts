/** Cloud boot policy, independent of runner/SDK package identity. */
export const CLOUD_RUNNER_KERNEL = {
  url: 'https://github.com/boxlite-ai/libkrunfw/releases/download/v5.4.0/libkrunfw-kernel-dind-x86_64.bin',
  sha256: '3c6cfc8015a1ba05cebabecd37967d665f2a0f81424b69f8d43d6e87feaceb92',
}

/** Shared by first boot, AWS commands and GCP policy enforcement. */
export const kernelDeployment = (kernel = CLOUD_RUNNER_KERNEL) => {
  if (
    !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9/_.-]+$/.test(kernel.url) ||
    !/^[0-9a-f]{64}$/.test(kernel.sha256)
  ) {
    throw new Error('runner kernel requires an HTTPS asset URL and a lowercase SHA256')
  }
  const setup = `KERNEL_PATH='/opt/boxlite/kernels/${kernel.sha256}/kernel.bin'
KERNEL_ENV='/etc/boxlite/kernel.env'
KERNEL_DROPIN='/etc/systemd/system/boxlite-runner.service.d/kernel.conf'

runner_kernel_bytes_match() {
  [ -f "$KERNEL_PATH" ] && printf '%s  %s\\n' '${kernel.sha256}' "$KERNEL_PATH" | sha256sum --check --status
}

runner_kernel_matches() {
  runner_kernel_bytes_match &&
    grep -qxF "BOXLITE_KERNEL_PATH=$KERNEL_PATH" "$KERNEL_ENV" &&
    [ "$(cat "$KERNEL_DROPIN" 2>/dev/null)" = "$(printf '[Service]\\nEnvironmentFile=%s' "$KERNEL_ENV")" ] &&
    systemctl is-active --quiet boxlite-runner
}

fetch_runner_kernel() {
  if runner_kernel_bytes_match; then return 0; fi
  mkdir -p "$(dirname "$KERNEL_PATH")" || return 1
  local partial
  partial=$(mktemp "$(dirname "$KERNEL_PATH")/.download.XXXXXX") || return 1
  if curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \\
      --connect-timeout 10 --max-time 120 \\
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
    install: `${setup}\ninstall_runner_kernel\n`,
    enforce: `set -euo pipefail
${setup}
# First boot installs its own kernel before enabling the service.
if ! systemctl is-enabled --quiet boxlite-runner 2>/dev/null; then exit 0; fi
if runner_kernel_matches; then echo 'runner kernel already current'; exit 0; fi
# A failed download must not stop the serving runner or change its configuration.
fetch_runner_kernel
KERNEL_BACKUP=$(mktemp -d)
for file in "$KERNEL_ENV" "$KERNEL_DROPIN"; do
  if [ -f "$file" ]; then cp -a "$file" "$KERNEL_BACKUP/$(basename "$file")"; fi
done
if write_runner_kernel_config && systemctl daemon-reload &&
    systemctl restart boxlite-runner && runner_kernel_matches; then
  rm -rf "$KERNEL_BACKUP"
else
  for file in "$KERNEL_ENV" "$KERNEL_DROPIN"; do
    if [ -f "$KERNEL_BACKUP/$(basename "$file")" ]; then
      mv -f "$KERNEL_BACKUP/$(basename "$file")" "$file"
    else
      rm -f "$file"
    fi
  done
  rm -rf "$KERNEL_BACKUP"
  systemctl daemon-reload
  systemctl restart boxlite-runner || true
  echo 'runner kernel activation failed; restored previous configuration' >&2
  exit 1
fi
`,
  }
}
