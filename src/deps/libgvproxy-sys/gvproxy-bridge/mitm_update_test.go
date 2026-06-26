package main

import "testing"

func TestSecretHostMatcherUpdateReplacesRulesInPlace(t *testing.T) {
	matcher := NewSecretHostMatcher([]SecretConfig{{
		Name:        "openai",
		Value:       "old",
		Hosts:       []string{"api.openai.com"},
		Placeholder: "<BOXLITE_SECRET:openai>",
	}})

	if !matcher.Matches("api.openai.com") {
		t.Fatal("expected initial host to match")
	}

	matcher.Update([]SecretConfig{{
		Name:        "anthropic",
		Value:       "new",
		Hosts:       []string{"api.anthropic.com"},
		Placeholder: "<BOXLITE_SECRET:anthropic>",
	}})

	if matcher.Matches("api.openai.com") {
		t.Fatal("expected old host to be removed")
	}
	if !matcher.Matches("api.anthropic.com") {
		t.Fatal("expected updated host to match")
	}

	secrets := matcher.SecretsForHost("api.anthropic.com")
	if len(secrets) != 1 || secrets[0].Value != "new" {
		t.Fatalf("unexpected secrets after update: %#v", secrets)
	}
}

func TestSecretHostMatcherHasRules(t *testing.T) {
	matcher := NewSecretHostMatcher(nil)
	if matcher.HasRules() {
		t.Fatal("empty matcher should not have rules")
	}

	matcher.Update([]SecretConfig{{
		Name:        "openai",
		Value:       "value",
		Hosts:       []string{"*.openai.com"},
		Placeholder: "<BOXLITE_SECRET:openai>",
	}})
	if !matcher.HasRules() {
		t.Fatal("updated matcher should have rules")
	}
}
