// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package shellutil

import (
	"strings"
	"testing"
)

// The web terminal (xterm.js) and SSH sessions render in ANSI-capable
// terminals, but the box VM ships no TERM by default, so color-aware
// programs (git, ls, prompts) suppress color. The launcher must export a
// usable TERM so those tools light up. The `${TERM:-...}` fallback keeps a
// real SSH client's own TERM when one is already present.
func TestDefaultInteractiveShellExportsTERM(t *testing.T) {
	_, args := DefaultInteractiveShell()
	script := strings.Join(args, " ")

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

func TestDefaultInteractiveShellConfiguresLsColor(t *testing.T) {
	_, args := DefaultInteractiveShell()
	script := strings.Join(args, " ")

	if !strings.Contains(script, ".boxlite-shellrc") {
		t.Fatalf("interactive shell launcher must install a startup rc; got: %s", script)
	}
	if !strings.Contains(script, "--rcfile") {
		t.Fatalf("bash must load the BoxLite startup rc; got: %s", script)
	}
	if !strings.Contains(script, "ENV=\"$rc\"") {
		t.Fatalf("ash/sh must load the BoxLite startup rc through ENV; got: %s", script)
	}
	if !strings.Contains(script, "--color=auto") {
		t.Fatalf("interactive shell launcher must configure ls color; got: %s", script)
	}
	if !strings.Contains(script, "alias ls=") {
		t.Fatalf("interactive shell launcher must expose a colored ls alias; got: %s", script)
	}
	if !strings.Contains(script, "alias ls >/dev/null") {
		t.Fatalf("interactive shell launcher must preserve an existing ls alias; got: %s", script)
	}
	if !strings.Contains(script, "alias ll >/dev/null") {
		t.Fatalf("interactive shell launcher must preserve an existing ll alias; got: %s", script)
	}
}
