// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package shellutil

import (
	"strings"
	"testing"
)

func TestDefaultInteractiveShellRespectsImageWorkdir(t *testing.T) {
	command, args := DefaultInteractiveShell()
	if command != "/bin/sh" {
		t.Fatalf("command = %q, want /bin/sh", command)
	}
	if len(args) != 2 || args[0] != "-c" {
		t.Fatalf("args = %#v, want [-c <launcher>]", args)
	}

	launcher := args[1]
	// docker/kubectl exec parity: the launcher must NOT invent or force
	// /workspace — the exec already starts at the image WORKDIR.
	if strings.Contains(launcher, "mkdir") {
		t.Fatalf("launcher %q creates directories the image did not declare", launcher)
	}
	if strings.Contains(launcher, "cd /workspace") {
		t.Fatalf("launcher %q forces /workspace over the image WORKDIR", launcher)
	}
	// A broken cwd (deleted dir) must be rescued...
	if !strings.Contains(launcher, `[ -d "$PWD" ]`) {
		t.Fatalf("launcher %q does not validate the starting cwd", launcher)
	}
	// ...and a bare "/" landing (image with no WORKDIR) kicks to HOME.
	if !strings.Contains(launcher, `[ "$PWD" = "/" ]`) {
		t.Fatalf("launcher %q does not redirect a bare / landing to HOME", launcher)
	}
	if !strings.Contains(launcher, `cd "${HOME:-/root}"`) {
		t.Fatalf("launcher %q does not fall back to HOME", launcher)
	}
}

func TestDefaultInteractiveShellReportsCwdWithOSC7(t *testing.T) {
	_, args := DefaultInteractiveShell()
	launcher := args[1]

	if !strings.Contains(launcher, "PROMPT_COMMAND") {
		t.Fatalf("launcher %q does not configure PROMPT_COMMAND", launcher)
	}
	if !strings.Contains(launcher, `\033]7;file://boxlite`) {
		t.Fatalf("launcher %q does not emit OSC 7 cwd updates", launcher)
	}
}
