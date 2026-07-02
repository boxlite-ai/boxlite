// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package shellutil

import (
	"strings"
	"testing"
)

func TestDefaultInteractiveShellStartsInWorkspaceBeforeHome(t *testing.T) {
	command, args := DefaultInteractiveShell()
	if command != "/bin/sh" {
		t.Fatalf("command = %q, want /bin/sh", command)
	}
	if len(args) != 2 || args[0] != "-c" {
		t.Fatalf("args = %#v, want [-c <launcher>]", args)
	}

	launcher := args[1]
	if !strings.Contains(launcher, "mkdir -p /workspace") {
		t.Fatalf("launcher %q does not create /workspace", launcher)
	}
	workspaceIndex := strings.Index(launcher, "cd /workspace")
	if workspaceIndex < 0 {
		t.Fatalf("launcher %q does not cd to /workspace", launcher)
	}
	homeIndex := strings.Index(launcher, `cd "${HOME:-/root}"`)
	if homeIndex < 0 {
		t.Fatalf("launcher %q does not fall back to HOME", launcher)
	}
	if workspaceIndex > homeIndex {
		t.Fatalf("launcher %q tries HOME before /workspace", launcher)
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
