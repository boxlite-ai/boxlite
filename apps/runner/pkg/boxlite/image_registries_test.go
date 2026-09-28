// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// The runtime pulls the operator's curated images and the references tenants
// named from the same hosts, and core matches credentials by host. So the
// registry list it is built with must carry no credential at all: any one would
// be spent on a tenant's reference to that host. The insecure registries are
// kept as they were, HTTP and unverified, since reaching a local registry is
// about transport, not about whose token opens it.
func TestBuildImageRegistries_HoldsNoCredential(t *testing.T) {
	registries := buildImageRegistries([]string{"10.0.0.5:5000", "registry.local:5000"})

	if len(registries) != 2 {
		t.Fatalf("expected only the two insecure registries, got %d: %+v", len(registries), registries)
	}
	for _, registry := range registries {
		if registry.Transport != boxlite.RegistryTransportHTTP || !registry.SkipVerify {
			t.Errorf("%s: an insecure registry stays HTTP + SkipVerify, got %+v", registry.Host, registry)
		}
		if registry.Auth != (boxlite.ImageRegistryAuth{}) {
			t.Errorf("%s: the runtime must hold no registry credential, got %+v", registry.Host, registry.Auth)
		}
	}

	if got := buildImageRegistries(nil); len(got) != 0 {
		t.Errorf("no insecure registries means an empty list, got %+v", got)
	}
}
