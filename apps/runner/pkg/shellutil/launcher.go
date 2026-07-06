// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

// Package shellutil contains shared decisions about how to spawn an
// interactive shell inside a box VM. All three entry points that drop
// the user into a shell — the SSH gateway (sshgateway.Service), the
// dashboard's WebSocket terminal handler (controllers.handleWebSocketTerminal),
// and the proxy's iframe-terminal endpoint — should use the same selection
// logic so users see the same prompt regardless of how they arrived.
package shellutil

// DefaultInteractiveShell returns the command + args to pass to
// boxlite.Client.StartExecution when the caller wants an interactive shell
// session and the user has NOT supplied a specific command.
//
// Strategy: a POSIX `/bin/sh -c` launcher keeps the exec's working directory
// (the image WORKDIR), writes a small interactive-shell rc file, and execs the
// best available shell:
//
//	[ "$PWD" = "/" ] && { cd "${HOME:-/root}" 2>/dev/null || true; };
//	export TERM="${TERM:-xterm-256color}";
//	shell=$(command -v bash || command -v ash || command -v sh);
//	rc="/tmp/.boxlite-shellrc.$$";
//	... write profile sourcing + prompt + OSC 7 cwd reporting ...
//	exec "$shell" --rcfile "$rc" -i    # bash
//	export ENV="$rc"; exec "$shell" -i # ash/sh
//
// Why this shape:
//
//   - `/bin/sh` is required by POSIX, so the launcher process itself always
//     starts. We don't have to guess what the VM ships before we connect.
//   - The exec already starts at the image WORKDIR (`docker exec` /
//     `kubectl exec` parity — see Container::cmd in the guest), so standard
//     BoxLite images land in /workspace via their own Dockerfile. We do NOT
//     create or force /workspace here: custom images may not have it, and
//     inventing directories the image author didn't declare breaks the
//     image's own layout. The `$PWD = /` kick gives images with no
//     declared WORKDIR an ssh-like landing in `${HOME:-/root}` instead of
//     bare `/` — the one UX half-step we take beyond plain `docker exec`.
//   - `command -v` is POSIX and works on busybox/alpine (the default
//     BoxLite snapshot), bash-only distros, and everything in between.
//     Trying bash first, then ash, then sh matches user preference for
//     bash where it exists while falling through cleanly on minimal images.
//   - The generated rc sources /etc/profile, ~/.profile, and (for bash)
//     ~/.bashrc before applying BoxLite's default prompt. This keeps normal
//     image/user initialization while making a plain minimal shell look like
//     the BoxLite terminal surface.
//   - The rc sets a BoxLite-themed prompt for the default terminal surface:
//     user/host stays green while the cwd segment uses the brand-blue ANSI
//     256-color slot (38;5;39, close to #00B0F0). Set BOXLITE_KEEP_PS1=1 in
//     the image/user rc if a custom image wants to keep its own prompt.
//   - `PROMPT_COMMAND` emits OSC 7 cwd updates for shells that support it,
//     allowing the dashboard terminal to keep upload destinations aligned
//     with the user's current directory.
//   - `exec` replaces the launcher sh in-place — no extra PID hangs around
//     and the chosen shell becomes pid 1 of the SSH/terminal session.
//   - `export TERM="${TERM:-xterm-256color}"` gives color-aware programs a
//     terminal type to key off. The box VM ships no TERM, so without it
//     git/less/prompts render monochrome even though the client (xterm.js
//     or the SSH terminal) can display color. The `:-` fallback preserves a
//     real SSH client's own TERM when one is already present.
//
// This follows the kubectl exec convention for unknown container images
// (see https://kubernetes.io/docs/reference/kubectl/generated/kubectl_exec/),
// which is the closest established pattern for "spawn a shell inside a
// container/VM I don't fully control."
//
// If you need a specific shell (e.g. running a one-shot command from a
// `ssh user@host "ls -la"` invocation), skip this helper and pass
// `/bin/sh` with `-c <command>` directly — there is no ambiguity to
// resolve in that case.
func DefaultInteractiveShell() (command string, args []string) {
	return "/bin/sh", []string{"-c", `[ "$PWD" = "/" ] && { cd "${HOME:-/root}" 2>/dev/null || true; }
export TERM="${TERM:-xterm-256color}"
shell=$(command -v bash || command -v ash || command -v sh)
rc="/tmp/.boxlite-shellrc.$$"
umask 077
cat > "$rc" <<'BOXLITE_RC'
[ -r /etc/profile ] && . /etc/profile
[ -r "$HOME/.profile" ] && . "$HOME/.profile"
[ -n "$BASH_VERSION" ] && [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
if [ -n "$BASH_VERSION" ]; then
  export PROMPT_COMMAND='printf "\033]7;file://boxlite%s\007" "$PWD"'
fi
if [ -z "$BOXLITE_KEEP_PS1" ]; then
  boxlite_green="$(printf '\033[1;32m')"
  boxlite_blue="$(printf '\033[38;5;39m')"
  boxlite_reset="$(printf '\033[0m')"
  if [ -n "$BASH_VERSION" ]; then
    PS1='\[\033[1;32m\]\u@\h:\[\033[38;5;39m\]\w\[\033[0m\]\$ '
  else
    PS1="${boxlite_green}\u@\h:${boxlite_blue}\w${boxlite_reset}\$ "
  fi
fi
BOXLITE_RC
case "$shell" in
  *bash) exec "$shell" --rcfile "$rc" -i ;;
  *) export ENV="$rc"; exec "$shell" -i ;;
esac`,
	}
}

// SftpSubsystem returns the command + args to spawn an SFTP server inside
// the VM in response to an SSH `subsystem sftp` request (RFC 4254 §6.5;
// modern OpenSSH scp defaults to this protocol).
//
// Probes the common install paths in order (alpine, debian-ish, RHEL-ish,
// PATH) and refuses to exec an empty binary path — without the guard, a
// missing sftp-server would land at `exec ` (no-op, exit 0) and the
// client would see "Connection closed" with no explanation. The explicit
// "not found" message lets users see the gap and fall back to
// `scp -O -P 2222 ...` (legacy protocol over `exec`).
func SftpSubsystem() (command string, args []string) {
	return "/bin/sh", []string{"-c",
		`bin=$(command -v sftp-server 2>/dev/null || ` +
			`ls /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/libexec/openssh/sftp-server 2>/dev/null | head -n1); ` +
			`if [ -z "$bin" ]; then ` +
			`echo "boxlite: sftp-server not found in box VM; install openssh-sftp-server (or 'apk add openssh-sftp-server'), or fall back to 'scp -O'" >&2; ` +
			`exit 127; ` +
			`fi; ` +
			`exec "$bin"`,
	}
}
