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
