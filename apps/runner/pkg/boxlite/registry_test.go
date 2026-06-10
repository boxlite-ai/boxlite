// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import "testing"

func TestNormalizeRegistryHosts(t *testing.T) {
	hosts := normalizeRegistryHosts([]string{
		" http://registry.local:5000/ ",
		"https://example.com/project",
		"",
	})

	want := []string{"registry.local:5000", "example.com"}
	if len(hosts) != len(want) {
		t.Fatalf("expected %d hosts, got %d: %#v", len(want), len(hosts), hosts)
	}

	for i := range want {
		if hosts[i] != want[i] {
			t.Fatalf("host %d: expected %q, got %q", i, want[i], hosts[i])
		}
	}
}
