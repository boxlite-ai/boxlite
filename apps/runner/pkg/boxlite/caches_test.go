//go:build boxlite_dev

package boxlite

import (
	"context"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"os"
	"path/filepath"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestCacheLeaseCatalogRecoveryAndPaths(t *testing.T) {
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "unit-only")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	t.Setenv("ENVIRONMENT", "development")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	} // No skips qualify this contract.
	defer client.Close()
	tenant := "11111111-1111-4111-8111-111111111111"
	input := dto.CreateBoxDTO{Id: "cache-owner", Image: "alpine:3.23", OrganizationId: &tenant,
		OutboundEnabled: boolPtr(true), SkipStart: boolPtr(true),
		Volumes: []dto.VolumeDTO{{Type: "cache", VolumeId: "test-cache", MountPath: "/cache"}}}
	if _, _, err := client.Create(ctx, input); err != nil {
		t.Fatal(err)
	}
	if err := client.CacheRemove(ctx, tenant, "test-cache", nil); !sdk.IsInvalidState(err) {
		t.Fatalf("active removal: %v", err)
	}
	input.Id = "contender"
	if _, _, err := client.Create(ctx, input); !sdk.IsInvalidState(err) {
		t.Fatalf("concurrent writer: %v", err)
	}
	if err := client.Destroy(ctx, "cache-owner"); err != nil {
		t.Fatal(err)
	}
	// Reload lease bytes and query actual native catalog; no test-generated
	// success value or fake liveness predicate supplies the recovery decision.
	info, err := client.CacheGet(ctx, tenant, "test-cache")
	if err != nil || info.InUse {
		t.Fatalf("deleted owner not reclaimed: %+v %v", info, err)
	}
	if _, _, err := client.Create(ctx, input); err != nil {
		t.Fatal(err)
	}
	if err := client.Destroy(ctx, input.Id); err != nil {
		t.Fatal(err)
	}
	if err := client.CacheRemove(ctx, tenant, "test-cache", nil); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"../escape", "/absolute", "a/b", "", "."} {
		if _, err := client.cachePath(tenant, id, true); err == nil {
			t.Fatalf("accepted %q", id)
		}
	}
	root := filepath.Join(client.homeDir, "cache-volumes", tenant)
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "symlink")); err != nil {
		t.Fatal(err)
	}
	if _, err := client.cachePath(tenant, "symlink", true); err == nil {
		t.Fatal("accepted symlink")
	}
}
