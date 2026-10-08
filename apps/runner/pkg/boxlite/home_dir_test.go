// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"os/user"
	"path/filepath"
	"testing"
)

func TestResolveHomeDirFollowsCoreOrder(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Skipf("no passwd entry for the current user: %v", err)
	}

	tests := []struct {
		name        string
		configured  string
		boxliteHome string
		home        string
		want        string
	}{
		{
			name:        "configured directory wins",
			configured:  "/srv/boxlite",
			boxliteHome: "/env/boxlite",
			home:        "/home/runner",
			want:        "/srv/boxlite",
		},
		{
			name:        "BOXLITE_HOME when nothing is configured",
			boxliteHome: "/env/boxlite",
			home:        "/home/runner",
			want:        "/env/boxlite",
		},
		{
			name: ".boxlite under HOME",
			home: "/home/runner",
			want: "/home/runner/.boxlite",
		},
		{
			name: "passwd home when HOME is unset",
			want: filepath.Join(current.HomeDir, ".boxlite"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("BOXLITE_HOME", tt.boxliteHome)
			t.Setenv("HOME", tt.home)

			got, err := resolveHomeDir(tt.configured)
			if err != nil {
				t.Fatalf("resolveHomeDir(%q) error = %v", tt.configured, err)
			}
			if got != tt.want {
				t.Fatalf("resolveHomeDir(%q) = %q, want %q", tt.configured, got, tt.want)
			}
		})
	}
}
