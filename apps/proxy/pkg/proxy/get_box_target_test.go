// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import "testing"

func TestParseProxyHostTerminalNamespace(t *testing.T) {
	p := &Proxy{}

	targetPort, token, baseHost, isTerminal, err := p.parseProxyHost("terminal-signedtoken.proxy.example.com")
	if err != nil {
		t.Fatalf("parseProxyHost returned error: %v", err)
	}
	if targetPort != "" {
		t.Fatalf("targetPort = %q, want empty", targetPort)
	}
	if token != "signedtoken" {
		t.Fatalf("token = %q, want signedtoken", token)
	}
	if baseHost != "proxy.example.com" {
		t.Fatalf("baseHost = %q, want proxy.example.com", baseHost)
	}
	if !isTerminal {
		t.Fatal("isTerminal = false, want true")
	}
}

func TestParseProxyHostTreats22222AsUserPort(t *testing.T) {
	p := &Proxy{}

	targetPort, boxId, _, isTerminal, err := p.parseProxyHost("22222-box123.proxy.example.com")
	if err != nil {
		t.Fatalf("parseProxyHost returned error: %v", err)
	}
	if targetPort != "22222" {
		t.Fatalf("targetPort = %q, want 22222", targetPort)
	}
	if boxId != "box123" {
		t.Fatalf("boxId = %q, want box123", boxId)
	}
	if isTerminal {
		t.Fatal("isTerminal = true, want false")
	}
}
