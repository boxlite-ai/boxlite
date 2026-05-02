// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import (
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

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

func TestParseReferenceUsesConfiguredInsecureRegistry(t *testing.T) {
	client := &Client{
		insecureRegistries: normalizeRegistryHosts([]string{"registry.local:5000"}),
	}

	ref, err := client.parseReference("registry.local:5000/project/image:tag", &dto.RegistryDTO{
		Url: "registry.local:5000",
	})
	if err != nil {
		t.Fatalf("parse reference: %v", err)
	}

	if got := ref.Context().Registry.Scheme(); got != "http" {
		t.Fatalf("expected insecure registry scheme http, got %q", got)
	}
}

func TestParseReferenceUsesHttpRegistryURLAsInsecure(t *testing.T) {
	client := &Client{}

	ref, err := client.parseReference("registry.local:5000/project/image:tag", &dto.RegistryDTO{
		Url: "http://registry.local:5000",
	})
	if err != nil {
		t.Fatalf("parse reference: %v", err)
	}

	if got := ref.Context().Registry.Scheme(); got != "http" {
		t.Fatalf("expected http registry URL to force scheme http, got %q", got)
	}
}

func TestSanitizeImageReferenceStripsScheme(t *testing.T) {
	got := sanitizeImageReference("https://registry.local:5000/project/image:tag")
	want := "registry.local:5000/project/image:tag"

	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}
