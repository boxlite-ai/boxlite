// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestSecretSpecsPreservesFields(t *testing.T) {
	got := secretSpecs([]dto.SecretDTO{
		{Name: "openai", Value: "sk-test", Hosts: []string{"api.openai.com"}, Placeholder: "<BOXLITE_SECRET:openai>"},
		{Name: "httpbin", Value: "v2", Hosts: []string{"httpbin.org"}, Placeholder: ""},
	})

	if len(got) != 2 {
		t.Fatalf("expected 2 secrets, got %d", len(got))
	}

	if got[0].Name != "openai" || got[0].Value != "sk-test" {
		t.Errorf("secret 0: got %+v", got[0])
	}
	if len(got[0].Hosts) != 1 || got[0].Hosts[0] != "api.openai.com" {
		t.Errorf("secret 0 hosts: got %v", got[0].Hosts)
	}
	if got[0].Placeholder != "<BOXLITE_SECRET:openai>" {
		t.Errorf("secret 0 placeholder: got %q", got[0].Placeholder)
	}

	// Empty placeholder is passed through verbatim: the SDK applies the default.
	if got[1].Placeholder != "" {
		t.Errorf("secret 1 placeholder should be empty, got %q", got[1].Placeholder)
	}
}

func TestSecretSpecsEmptyAndNil(t *testing.T) {
	if got := secretSpecs(nil); len(got) != 0 {
		t.Fatalf("nil should map to zero secrets, got %d", len(got))
	}
	if got := secretSpecs([]dto.SecretDTO{}); len(got) != 0 {
		t.Fatalf("empty should map to zero secrets, got %d", len(got))
	}
}
