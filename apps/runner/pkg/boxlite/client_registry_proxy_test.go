// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"bytes"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

var configuredProxy = RegistryProxy{
	Host:     "registry-proxy-123.run.app",
	Username: "runner",
	Password: "the-runners-own-key",
}

// The registry proxy is one more ImageRegistry, shaped exactly as the ghcr entry
// is: an authenticated HTTPS host. That is the whole integration — the runtime
// and every SDK already carry this type, so nothing below the runner changes.
func TestBuildImageRegistries_RegistryProxyIsAnAuthenticatedHTTPSHost(t *testing.T) {
	registries := buildImageRegistries(nil, "", "", configuredProxy)

	proxy, ok := findRegistry(registries, configuredProxy.Host)
	if !ok {
		t.Fatalf("no entry for the registry proxy, got %+v", registries)
	}
	want := boxlite.ImageRegistry{
		Host:      configuredProxy.Host,
		Transport: boxlite.RegistryTransportHTTPS,
		Auth:      boxlite.ImageRegistryAuth{Username: "runner", Password: "the-runners-own-key"},
	}
	if !reflect.DeepEqual(proxy, want) {
		t.Errorf("registry proxy entry = %+v, want %+v", proxy, want)
	}

	// Same shape as ghcr's: the two differ in host and credential and nothing else.
	ghcr, _ := findRegistry(buildImageRegistries(nil, "u", "p", RegistryProxy{}), "ghcr.io")
	if proxy.Transport != ghcr.Transport || proxy.SkipVerify != ghcr.SkipVerify || proxy.Search != ghcr.Search {
		t.Errorf("registry proxy entry %+v is not shaped like the ghcr entry %+v", proxy, ghcr)
	}
}

// Search decides whether an unqualified reference — `alpine:3.20` — is tried
// against this host. Were it on, every image a caller names without a registry
// would be offered to the proxy first, which is the creation path this release
// promises to leave alone.
func TestBuildImageRegistries_RegistryProxyIsNeverSearched(t *testing.T) {
	proxy, ok := findRegistry(buildImageRegistries(nil, "", "", configuredProxy), configuredProxy.Host)
	if !ok {
		t.Fatal("no entry for the registry proxy")
	}
	if proxy.Search {
		t.Error("the registry proxy is searched for unqualified references, so alpine:3.20 would resolve to it")
	}
}

// Shipped dark: with nothing configured, the list is exactly what it was before
// the registry proxy existed, so deploying this changes nothing until a stage
// opts in.
func TestBuildImageRegistries_NoRegistryProxyIsTheOldListExactly(t *testing.T) {
	insecure := []string{"10.0.0.5:5000"}
	without := buildImageRegistries(insecure, "boxlite-ci", "ghp_secret", RegistryProxy{})

	if len(without) != 2 {
		t.Fatalf("expected the insecure and ghcr entries alone, got %d: %+v", len(without), without)
	}
	for _, registry := range without {
		if registry.Host == configuredProxy.Host {
			t.Errorf("an unconfigured registry proxy produced an entry: %+v", registry)
		}
	}
}

// Two of the three is a stage that meant to configure the proxy and did not
// finish. Adding an entry would send the runner to a proxy it cannot
// authenticate to; adding none, and saying so, is recoverable.
func TestBuildImageRegistries_PartialRegistryProxyAddsNothing(t *testing.T) {
	for name, partial := range map[string]RegistryProxy{
		"no password": {Host: configuredProxy.Host, Username: "runner"},
		"no username": {Host: configuredProxy.Host, Password: "k"},
		"no host":     {Username: "runner", Password: "k"},
	} {
		registries := buildImageRegistries(nil, "", "", partial)
		if len(registries) != 0 {
			t.Errorf("%s: a partial registry proxy produced %+v", name, registries)
		}
	}
}

// The runtime matches a host to the first entry naming it and ignores the rest,
// for transport and credential alike. A proxy that is also listed as insecure —
// the local stack's, served over plain HTTP — would otherwise be two entries,
// and the first, which carries no credential, would win: every pull through it
// answered 401 by a proxy that was configured correctly.
func TestBuildImageRegistries_InsecureRegistryProxyIsOneEntryWithItsCredential(t *testing.T) {
	local := RegistryProxy{Host: "127.0.0.1:4100", Username: "runner", Password: "local-key"}
	registries := buildImageRegistries([]string{"127.0.0.1:25000", "127.0.0.1:4100"}, "", "", local)

	var named []boxlite.ImageRegistry
	for _, registry := range registries {
		if registry.Host == local.Host {
			named = append(named, registry)
		}
	}
	if len(named) != 1 {
		t.Fatalf("%s is named by %d entries, want one: %+v", local.Host, len(named), named)
	}
	if named[0].Transport != boxlite.RegistryTransportHTTP {
		t.Errorf("transport = %q, want HTTP for a proxy listed as insecure", named[0].Transport)
	}
	if named[0].Auth.Username != "runner" || named[0].Auth.Password != "local-key" {
		t.Errorf("the one entry carries %+v, want the proxy's credential", named[0].Auth)
	}

	// The other insecure registry is untouched.
	if other, ok := findRegistry(registries, "127.0.0.1:25000"); !ok || other.Transport != boxlite.RegistryTransportHTTP {
		t.Errorf("the local registry lost its insecure entry: %+v", registries)
	}
}

// The runtime compares a bare host, so a proxy address written as a URL — the
// shape a stack output hands over — has to be reduced to one, or no reference
// ever matches it.
func TestBuildImageRegistries_RegistryProxyHostIsNormalized(t *testing.T) {
	written := configuredProxy
	written.Host = "https://registry-proxy-123.run.app/"

	if _, ok := findRegistry(buildImageRegistries(nil, "", "", written), "registry-proxy-123.run.app"); !ok {
		t.Errorf("a proxy host written as a URL did not reduce to its host")
	}
}

func TestWarnOnPartialRegistryProxySaysWhatIsMissing(t *testing.T) {
	var logged bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logged, nil))

	// The password is given and the username is not, so the credential reaches
	// the code under test and the one thing missing is something else.
	warnOnPartialRegistryProxy(logger, RegistryProxy{Host: configuredProxy.Host, Password: configuredProxy.Password})
	if !strings.Contains(logged.String(), "REGISTRY_PROXY_USERNAME") {
		t.Errorf("the warning does not name the missing variable: %q", logged.String())
	}
	if strings.Contains(logged.String(), configuredProxy.Password) {
		t.Errorf("the warning carried the credential it was handed: %q", logged.String())
	}

	for name, proxy := range map[string]RegistryProxy{"complete": configuredProxy, "absent": {}} {
		logged.Reset()
		warnOnPartialRegistryProxy(logger, proxy)
		if logged.Len() != 0 {
			t.Errorf("%s: warned %q, want nothing", name, logged.String())
		}
	}
}

// Configuring the proxy adds one entry and touches no other. Every image that
// does not name the proxy's host keeps the transport and credential it had —
// which is what leaves the public and curated creation paths exactly as they
// were.
func TestBuildImageRegistries_RegistryProxyLeavesEveryOtherEntryAlone(t *testing.T) {
	insecure := []string{"10.0.0.5:5000", "127.0.0.1:25000"}
	without := buildImageRegistries(insecure, "boxlite-ci", "ghp_secret", RegistryProxy{})
	with := buildImageRegistries(insecure, "boxlite-ci", "ghp_secret", configuredProxy)

	var others []boxlite.ImageRegistry
	for _, registry := range with {
		if registry.Host != configuredProxy.Host {
			others = append(others, registry)
		}
	}
	if !reflect.DeepEqual(others, without) {
		t.Errorf("adding the registry proxy changed the other entries:\n with:    %+v\n without: %+v", others, without)
	}
	if len(with) != len(without)+1 {
		t.Errorf("adding the registry proxy added %d entries, want exactly one", len(with)-len(without))
	}
}

// A host that is set but reduces to nothing — a bare scheme, whitespace — is as
// unusable as one left out, and must be reported the same way. Judged on the
// raw string it looks complete, adds no entry, and says nothing: the proxy
// quietly off with every variable apparently in place.
func TestAnUnusableRegistryProxyHostIsReportedNotSilentlyDropped(t *testing.T) {
	for _, host := range []string{"https://", "   ", "https:///"} {
		unusable := RegistryProxy{Host: host, Username: "runner", Password: configuredProxy.Password}

		if registries := buildImageRegistries(nil, "", "", unusable); len(registries) != 0 {
			t.Errorf("host %q produced %+v", host, registries)
		}

		var logged bytes.Buffer
		warnOnPartialRegistryProxy(slog.New(slog.NewTextHandler(&logged, nil)), unusable)
		if !strings.Contains(logged.String(), "REGISTRY_PROXY_HOST") {
			t.Errorf("host %q was dropped without a warning naming it: %q", host, logged.String())
		}
	}
}
