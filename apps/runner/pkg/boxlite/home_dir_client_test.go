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

// With neither BOXLITE_HOME_DIR, $BOXLITE_HOME nor $HOME set, the home comes
// from the passwd entry. The client must report the directory it opened, or code
// that reads the home (migration staging) disagrees with the runtime. The passwd
// lookup is stubbed to a temporary directory so the runtime never opens, locks or
// recovers the developer's real ~/.boxlite.
func TestNewClientReportsThePasswdHomeWhenHomeIsUnset(t *testing.T) {
	passwdHome := t.TempDir()
	lookup := currentUser
	t.Cleanup(func() { currentUser = lookup })
	currentUser = func() (*user.User, error) {
		return &user.User{Username: "runner", HomeDir: passwdHome}, nil
	}
	unsetenv(t, "BOXLITE_HOME")
	unsetenv(t, "HOME")

	client, err := NewClient(context.Background(), ClientConfig{})
	if err != nil {
		skipOrFailRuntimeStart(t, err)
	}
	t.Cleanup(func() { _ = client.Close() })

	want := filepath.Join(passwdHome, ".boxlite")
	if got := client.HomeDir(); got != want {
		t.Fatalf("client home = %q, want %q", got, want)
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
