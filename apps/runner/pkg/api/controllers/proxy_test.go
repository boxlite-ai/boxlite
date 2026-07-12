// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package controllers

import "testing"

func TestNormalizeToolboxPath(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"", "/"},
		{"/", "/"},
		{"proxy/6080", "/proxy/6080"},
		{"/proxy/6080/", "/proxy/6080/"},
		{"computeruse/status", "/computeruse/status"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := normalizeToolboxPath(tt.path); got != tt.want {
				t.Fatalf("normalizeToolboxPath(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}
