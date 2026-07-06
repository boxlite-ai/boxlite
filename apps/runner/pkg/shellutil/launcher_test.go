// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package shellutil

import (
	"strings"
	"testing"
)

func launcherScript(t *testing.T) string {
	t.Helper()
	command, args := DefaultInteractiveShell()
	if command != "/bin/sh" {
		t.Fatalf("command = %q, want /bin/sh", command)
	}
	if len(args) != 2 || args[0] != "-c" {
		t.Fatalf("args = %#v, want [-c <launcher>]", args)
	}
	return args[1]
}

func TestDefaultInteractiveShellRespectsImageWorkdir(t *testing.T) {
	launcher := launcherScript(t)

	// docker/kubectl exec parity: the launcher must NOT invent or force
	// /workspace — the exec already starts at the image WORKDIR.
	if strings.Contains(launcher, "mkdir") {
		t.Fatalf("launcher %q creates directories the image did not declare", launcher)
	}
	if strings.Contains(launcher, "cd /workspace") {
		t.Fatalf("launcher %q forces /workspace over the image WORKDIR", launcher)
	}
	// A bare "/" landing (image with no WORKDIR) kicks to HOME.
	if !strings.Contains(launcher, `[ "$PWD" = "/" ]`) {
		t.Fatalf("launcher %q does not redirect a bare / landing to HOME", launcher)
	}
	if !strings.Contains(launcher, `cd "${HOME:-/root}"`) {
		t.Fatalf("launcher %q does not fall back to HOME", launcher)
	}
}

// The web terminal (xterm.js) and SSH sessions render in ANSI-capable
// terminals, but the box VM ships no TERM by default, so color-aware
// programs (git, ls, prompts) suppress color. The launcher must export a
// usable TERM so those tools light up. The `${TERM:-...}` fallback keeps a
// real SSH client's own TERM when one is already present.
func TestDefaultInteractiveShellExportsTERM(t *testing.T) {
	script := launcherScript(t)

	if !strings.Contains(script, "TERM=") {
		t.Fatalf("interactive shell launcher must export TERM; got: %s", script)
	}
	if !strings.Contains(script, "xterm-256color") {
		t.Fatalf("interactive shell launcher must default TERM to xterm-256color; got: %s", script)
	}
	if !strings.Contains(script, "${TERM:-") {
		t.Fatalf("TERM must use a :- fallback so an existing (SSH client) TERM is preserved; got: %s", script)
	}
}

func TestDefaultInteractiveShellUsesBoxLitePromptColors(t *testing.T) {
	script := launcherScript(t)

	if !strings.Contains(script, ".boxlite-shellrc") {
		t.Fatalf("interactive shell launcher must install a startup rc; got: %s", script)
	}
	if !strings.Contains(script, "--rcfile") {
		t.Fatalf("bash must load the BoxLite startup rc; got: %s", script)
	}
	if !strings.Contains(script, "ENV=\"$rc\"") {
		t.Fatalf("ash/sh must load the BoxLite startup rc through ENV; got: %s", script)
	}
	if !strings.Contains(script, "BOXLITE_KEEP_PS1") {
		t.Fatalf("prompt customization must have an opt-out; got: %s", script)
	}
	if !strings.Contains(script, "38;5;39") {
		t.Fatalf("prompt cwd must use the BoxLite brand-blue ANSI color; got: %s", script)
	}
	if !strings.Contains(script, `\u@\h:`) || !strings.Contains(script, `\w`) {
		t.Fatalf("prompt must include user/host and cwd; got: %s", script)
	}
	if !strings.Contains(script, `\[\033[38;5;39m\]\w`) {
		t.Fatalf("bash prompt must wrap the brand-blue cwd escape for cursor accounting; got: %s", script)
	}
}

func TestDefaultInteractiveShellReportsCwdWithOSC7(t *testing.T) {
	launcher := launcherScript(t)

	if !strings.Contains(launcher, "PROMPT_COMMAND") {
		t.Fatalf("launcher %q does not configure PROMPT_COMMAND", launcher)
	}
	if !strings.Contains(launcher, `\033]7;file://boxlite`) {
		t.Fatalf("launcher %q does not emit OSC 7 cwd updates", launcher)
	}
}
