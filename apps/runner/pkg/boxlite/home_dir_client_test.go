//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"testing"
)

// With neither BOXLITE_HOME_DIR, $BOXLITE_HOME nor $HOME set, boxlite-core still
// finds a home through the passwd entry. The client must report that same
// directory, or code that reads the home (migration staging) disagrees with the
// runtime. This opens a real runtime in the passwd home's .boxlite.
func TestNewClientReportsThePasswdHomeWhenHomeIsUnset(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Skipf("no passwd entry for the current user: %v", err)
	}
	unsetenv(t, "BOXLITE_HOME")
	unsetenv(t, "HOME")

	client, err := NewClient(context.Background(), ClientConfig{})
	if err != nil {
		skipOrFailRuntimeStart(t, err)
	}
	t.Cleanup(func() { _ = client.Close() })

	want := filepath.Join(current.HomeDir, ".boxlite")
	if client.homeDir != want {
		t.Fatalf("client home = %q, want %q", client.homeDir, want)
	}
}

// unsetenv removes name for the rest of the test; t.Setenv records the value to
// restore. Core reads an empty variable as a value, so setting "" is not unset.
func unsetenv(t *testing.T, name string) {
	t.Helper()
	t.Setenv(name, "")
	if err := os.Unsetenv(name); err != nil {
		t.Fatalf("unset %s: %v", name, err)
	}
}
