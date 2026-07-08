// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"strings"
	"testing"
)

func TestIsTerminalToolboxPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"", true},
		{"/", true},
		{"proxy/22222", true},
		{"/proxy/22222", true},
		{"/proxy/22222/", true},
		{"/proxy/22222/vnc.html", true},
		{"/proxy/6080/", false},
		{"/computeruse/status", false},
		{"/process/execute", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isTerminalToolboxPath(tt.path); got != tt.want {
				t.Fatalf("isTerminalToolboxPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestTerminalHTMLDoesNotAcceptDashboardShellCommands(t *testing.T) {
	if !strings.Contains(terminalHTML, "msg.type==='cwd-request'") {
		t.Fatal("terminalHTML should still allow the dashboard to request terminal metadata")
	}

	forbidden := []string{
		"msg.type==='command'",
		"msg.command==='ls'",
		"ws.send('ls\\r')",
	}
	for _, needle := range forbidden {
		if strings.Contains(terminalHTML, needle) {
			t.Fatalf("terminalHTML must not inject shell input from dashboard messages; found %q", needle)
		}
	}
}
