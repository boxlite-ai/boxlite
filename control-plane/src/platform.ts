/** Platform facts of the BoxLite dev environment the prototype runs on. */

export const IMAGE_REFS: Record<string, string> = {
  base: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
  python: 'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0',
  node: 'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0',
};

export const BOX_SIZES: Record<string, { cpus: number; memory_mib: number }> = {
  nano: { cpus: 1, memory_mib: 1024 },
  small: { cpus: 1, memory_mib: 2048 },
  medium: { cpus: 2, memory_mib: 4096 },
  large: { cpus: 4, memory_mib: 8192 },
};

/** The org cap; bigger disks are rejected by BoxLite. */
export const BOX_DISK_GB = 10;
export const BOX_AUTO_STOP_S = 900;
/** The supervisor gateway listens here inside every app Box; the tunnel exposes only this port. */
export const GATEWAY_PORT = 8080;

/** Sign-in providers the CP knows; each also needs credentials (see oauth-providers.ts). */
export const SUPPORTED_AUTH_PROVIDERS = ['github', 'google'];

/**
 * The app Box's PID 1 (contracts §2.1), run as the image user `boxlite` on every start/wake.
 *
 * - Later starts: the root-owned launcher exists and sudo allows boxlite exactly that program,
 *   so `sudo -n` runs it. The launcher (root) downloads a newer supervisor into the root-only dir,
 *   keeps the cached one when the CP is unreachable, and execs it.
 * - First start of a new Box: boxlite still has the image's full NOPASSWD sudo. `sudo -E` runs
 *   BOX_CMD_ROOT as root: download into the root-only dir (keep the cached binary if the CP is
 *   down), exec it. The supervisor then installs the launcher and removes every other sudo right.
 *
 * The box token reaches only root processes: sh execs sudo (setuid, unreadable by boxlite) at once.
 * Scripts use double quotes only, so the Go e2e test (supervisor/internal/privilege) can read them
 * from this file verbatim.
 */
const BOX_CMD_BOOT = 'L=/usr/local/sbin/microcloud-sv; if [ -x "$L" ] && sudo -n -l "$L" >/dev/null 2>&1; then exec sudo -n "$L"; fi; exec sudo -n -E sh -c "$1" microcloud-root "$PATH"';
const BOX_CMD_ROOT = 'R=/home/boxlite/.microcloud-root; if [ -L "$R" ] || { [ -e "$R" ] && [ ! -d "$R" ]; } || { [ -d "$R" ] && [ "$(stat -c %u "$R")" != 0 ]; }; then rm -rf "$R"; fi; mkdir -p -m 700 "$R" && chmod 700 "$R" || exit 1; case "$(uname -m)" in aarch64|arm64) A=arm64;; *) A=amd64;; esac; until curl -fsS --max-time 20 "$BOXLITE_CP_URL/sv/bin/supervisor-linux-$A" -o "$R/sv.new" && chmod 755 "$R/sv.new" && mv -f "$R/sv.new" "$R/sv"; do [ -x "$R/sv" ] && break; sleep 2; done; exec "$R/sv" -box-path "$1"';
export const BOX_CMD = ['sh', '-c', BOX_CMD_BOOT, 'microcloud-boot', BOX_CMD_ROOT];

/**
 * The protocol-1 supervisor answers health without `version` (= 1). Boxes running it are restarted
 * once so their (old) cmd fetches the current binary, which then elevates itself (contracts §2.1).
 */
export const SUPERVISOR_PROTOCOL = 2;

export const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** First path segments the app proxy must never claim; app/env creation rejects them as names. */
export const RESERVED_NAMES = new Set(['v1', 'sv', 'admin', 'healthz', 'cli', 'agent', 'static', 'assets', 'api', 'login', 'logout', 'me', 'auth']);

export const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** App and env names: contracts §0 rule, plus no `--` (it separates app from env in proxy URLs). */
export function nameProblem(name: string): string | null {
  if (!NAME_RE.test(name)) return 'must match ^[a-z][a-z0-9-]{1,30}$';
  if (name.includes('--')) return 'must not contain "--" (it separates app and env in URLs)';
  if (name.endsWith('-')) return 'must not end with "-"';
  if (RESERVED_NAMES.has(name)) return 'is reserved by the control plane';
  return null;
}
