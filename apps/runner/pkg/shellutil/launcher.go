// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

// Package shellutil contains shared decisions about how to spawn an
// interactive shell inside a sandbox VM. All three entry points that drop
// the user into a shell — the SSH gateway (sshgateway.Service), the
// dashboard's WebSocket terminal handler (controllers.handleWebSocketTerminal),
// and the proxy's iframe-terminal endpoint — should use the same selection
// logic so users see the same prompt regardless of how they arrived.
package shellutil

// DefaultInteractiveShell returns the command + args to pass to
// boxlite.Client.StartExecution when the caller wants an interactive shell
// session and the user has NOT supplied a specific command.
//
// Strategy: a POSIX `/bin/sh -c` launcher cd's to the user's home and
// execs the best available shell as a login shell:
//
//	cd "${HOME:-/root}" 2>/dev/null || cd /;
//	exec $(command -v bash || command -v ash || command -v sh) -l
//
// Why this shape:
//
//   - `/bin/sh` is required by POSIX, so the launcher process itself always
//     starts. We don't have to guess what the VM ships before we connect.
//   - The `cd "$HOME"` step mirrors OpenSSH `sshd`'s chdir(pw_dir) before
//     exec'ing the user's shell. Without it the session lands at `/`,
//     which is jarring and breaks `~/.something` references in shell
//     startup files. `${HOME:-/root}` falls back to /root because the
//     default BoxLite snapshot runs as root with HOME=/root; `|| cd /`
//     keeps the launcher running even on minimal images that lack /root.
//   - `command -v` is POSIX and works on busybox/alpine (the default
//     BoxLite snapshot), bash-only distros, and everything in between.
//     Trying bash first, then ash, then sh matches user preference for
//     bash where it exists while falling through cleanly on minimal images.
//   - `exec` replaces the launcher sh in-place — no extra PID hangs around
//     and the chosen shell becomes pid 1 of the SSH/terminal session.
//   - `-l` makes it a *login* shell: /etc/profile and ~/.profile are
//     sourced, PATH is populated. Pairs with the cd above to match what
//     `ssh user@host` users expect when they land at a prompt.
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
	return "/bin/sh", []string{"-c",
		`cd "${HOME:-/root}" 2>/dev/null || cd /; ` +
			`exec $(command -v bash || command -v ash || command -v sh) -l`,
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
			`echo "boxlite: sftp-server not found in sandbox VM; install openssh-sftp-server (or 'apk add openssh-sftp-server'), or fall back to 'scp -O'" >&2; ` +
			`exit 127; ` +
			`fi; ` +
			`exec "$bin"`,
	}
}
