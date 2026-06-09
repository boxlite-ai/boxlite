package boxlite

import (
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

func findRegistry(registries []boxlite.ImageRegistry, host string) (boxlite.ImageRegistry, bool) {
	for _, r := range registries {
		if r.Host == host {
			return r, true
		}
	}
	return boxlite.ImageRegistry{}, false
}

// When ghcr creds are present, buildImageRegistries must add exactly one authenticated
// ghcr.io HTTPS entry alongside the unchanged insecure registries. This is the runtime-scoped
// auth that lets boxlite-core pull our private first-party images directly (no self-hosted
// mirror). The asserted data is produced by the production helper, not the test body.
func TestBuildImageRegistries_GhcrAuthAddedWhenCredsPresent(t *testing.T) {
	registries := buildImageRegistries([]string{"10.0.0.5:5000"}, "boxlite-ci", "ghp_secret")

	insecure, ok := findRegistry(registries, "10.0.0.5:5000")
	if !ok {
		t.Fatalf("expected insecure registry 10.0.0.5:5000 to be preserved, got %+v", registries)
	}
	if insecure.Transport != boxlite.RegistryTransportHTTP || !insecure.SkipVerify {
		t.Errorf("insecure registry should stay HTTP + SkipVerify, got %+v", insecure)
	}
	if insecure.Auth.Username != "" || insecure.Auth.Password != "" {
		t.Errorf("insecure registry must not carry auth, got %+v", insecure.Auth)
	}

	ghcr, ok := findRegistry(registries, "ghcr.io")
	if !ok {
		t.Fatalf("expected ghcr.io entry when creds set, got %+v", registries)
	}
	if ghcr.Transport != boxlite.RegistryTransportHTTPS {
		t.Errorf("ghcr.io must use HTTPS, got %q", ghcr.Transport)
	}
	if ghcr.Auth.Username != "boxlite-ci" || ghcr.Auth.Password != "ghp_secret" {
		t.Errorf("ghcr.io must carry the provided Basic creds, got %+v", ghcr.Auth)
	}
}

// Absent (or partial) creds must reproduce the legacy behavior exactly: no ghcr.io entry,
// so shipping this dark cannot change anything until GHCR_USERNAME+GHCR_TOKEN are set.
func TestBuildImageRegistries_NoGhcrWhenCredsAbsent(t *testing.T) {
	registries := buildImageRegistries([]string{"10.0.0.5:5000"}, "", "")
	if _, ok := findRegistry(registries, "ghcr.io"); ok {
		t.Errorf("ghcr.io must NOT be added when creds absent, got %+v", registries)
	}
	if len(registries) != 1 {
		t.Errorf("expected only the insecure registry, got %d: %+v", len(registries), registries)
	}

	partial := buildImageRegistries(nil, "boxlite-ci", "")
	if _, ok := findRegistry(partial, "ghcr.io"); ok {
		t.Errorf("ghcr.io must NOT be added with partial creds (username only), got %+v", partial)
	}
}
