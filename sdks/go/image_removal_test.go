//go:build boxlite_dev

package boxlite

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A real OCI pull feeds the native cache; no public registry or VM is needed.
func removalRegistry(t *testing.T) *httptest.Server {
	t.Helper()
	config := []byte(`{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}`)
	configID := fmt.Sprintf("sha256:%x", sha256.Sum256(config))
	layerID := fmt.Sprintf("sha256:%x", sha256.Sum256(nil))
	manifest, err := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"mediaType":     "application/vnd.oci.image.manifest.v1+json",
		"config":        map[string]any{"mediaType": "application/vnd.oci.image.config.v1+json", "digest": configID, "size": len(config)},
		"layers":        []any{map[string]any{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": layerID, "size": 0}},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifestID := fmt.Sprintf("sha256:%x", sha256.Sum256(manifest))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close")
		switch {
		case r.URL.Path == "/v2/":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		case strings.Contains(r.URL.Path, "/manifests/"):
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
			w.Header().Set("Docker-Content-Digest", manifestID)
			_, _ = w.Write(manifest)
		case strings.HasSuffix(r.URL.Path, "/blobs/"+configID):
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Length", fmt.Sprint(len(config)))
			_, _ = w.Write(config)
		case strings.HasSuffix(r.URL.Path, "/blobs/"+layerID):
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestImageRemovalByID(t *testing.T) {
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")
	registry := removalRegistry(t)
	host := strings.TrimPrefix(registry.URL, "http://")
	rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithImageRegistries(ImageRegistry{Host: host, Transport: RegistryTransportHTTP}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	images, err := rt.Images()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = images.Close() })
	ctx := context.Background()
	if _, err = images.Pull(ctx, host+"/app:latest"); err != nil {
		t.Fatal(err)
	}
	listed, err := images.List(ctx)
	if err != nil || len(listed) != 1 {
		t.Fatalf("list: %v, %v", listed, err)
	}
	id := listed[0].ID
	_, err = images.RemoveByID(ctx, id)
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != ErrImageHasTags || !strings.Contains(err.Error(), ":latest") {
		t.Fatalf("tag refusal: %v", err)
	}
	// The existing name operation still removes references and keeps the cache.
	if err = images.Remove(ctx, host+"/app"); err != nil {
		t.Fatal(err)
	}
	for _, repository := range []string{"app", "mirror"} {
		if _, err = images.Pull(ctx, host+"/"+repository+"@"+id); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := images.RemoveByID(ctx, id[7:19])
	if err != nil {
		t.Fatal(err)
	}
	if removed.ImageID != id || len(removed.RemovedReferences) != 2 || removed.ReclaimedBytes == 0 {
		t.Fatalf("removal result: %+v", removed)
	}
	listed, err = images.List(ctx)
	if err != nil || len(listed) != 0 {
		t.Fatalf("remaining images: %v, %v", listed, err)
	}
	_, err = images.RemoveByID(ctx, id)
	if !IsNotFound(err) {
		t.Fatalf("missing image: %v", err)
	}
}
