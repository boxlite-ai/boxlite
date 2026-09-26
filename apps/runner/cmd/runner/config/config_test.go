// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package config

import "testing"

func TestTheRegistryProxyLoginDefaultsToTheRunnersOwnKey(t *testing.T) {
	config := &Config{ApiToken: "runner-key", RegistryProxyHost: "registry-proxy.example"}

	defaultRegistryProxyLogin(config)

	if config.RegistryProxyPassword != "runner-key" || config.RegistryProxyUsername != "runner" {
		t.Errorf("login = %q/%q, want runner/runner-key", config.RegistryProxyUsername, config.RegistryProxyPassword)
	}
}

func TestAnExplicitRegistryProxyLoginIsKept(t *testing.T) {
	config := &Config{
		ApiToken:              "runner-key",
		RegistryProxyHost:     "registry-proxy.example",
		RegistryProxyUsername: "someone",
		RegistryProxyPassword: "set-on-purpose",
	}

	defaultRegistryProxyLogin(config)

	if config.RegistryProxyPassword != "set-on-purpose" || config.RegistryProxyUsername != "someone" {
		t.Errorf("login = %q/%q, want the configured one", config.RegistryProxyUsername, config.RegistryProxyPassword)
	}
}

func TestWithoutARegistryProxyNoLoginIsMadeUp(t *testing.T) {
	// The runner's key must not become a registry credential for no host: the
	// proxy's entry is the one exception to a runner holding none.
	config := &Config{ApiToken: "runner-key"}

	defaultRegistryProxyLogin(config)

	if config.RegistryProxyPassword != "" || config.RegistryProxyUsername != "" {
		t.Errorf("login = %q/%q with no proxy, want none", config.RegistryProxyUsername, config.RegistryProxyPassword)
	}
}
