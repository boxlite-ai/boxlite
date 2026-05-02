//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func newImageTestRuntime(t *testing.T) *Runtime {
	t.Helper()

	homeDir, err := os.MkdirTemp("/tmp", "boxlite-go-images-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(homeDir)
	})

	rt, err := NewRuntime(
		WithHomeDir(homeDir),
		WithImageRegistries(
			ImageRegistry{Host: "docker.m.daocloud.io", Search: true},
			ImageRegistry{Host: "docker.xuanyuan.me", Search: true},
			ImageRegistry{Host: "docker.1ms.run", Search: true},
			ImageRegistry{Host: "docker.io", Search: true},
		),
	)
	if err != nil {
		var e *Error
		if errors.As(err, &e) && (e.Code == ErrUnsupported || e.Code == ErrUnsupportedEngine) {
			t.Skipf("runtime not available: %v", err)
		}
		t.Fatalf("NewRuntime: %v", err)
	}
	t.Cleanup(func() {
		_ = rt.Close()
	})
	return rt
}

func TestImagesPullAndList(t *testing.T) {
	rt := newImageTestRuntime(t)

	images, err := rt.Images()
	if err != nil {
		t.Fatalf("Images: %v", err)
	}
	t.Cleanup(func() {
		_ = images.Close()
	})

	result, err := images.Pull(context.Background(), "alpine:latest")
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if result.Reference != "alpine:latest" {
		t.Errorf("Reference: got %q", result.Reference)
	}
	if result.ConfigDigest == "" {
		t.Fatal("ConfigDigest should not be empty")
	}
	if result.LayerCount <= 0 {
		t.Fatalf("LayerCount: got %d", result.LayerCount)
	}

	list, err := images.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) == 0 {
		t.Fatal("expected at least one cached image")
	}

	found := false
	for _, info := range list {
		if strings.Contains(info.Repository, "alpine") && info.Tag == "latest" {
			if info.ID == "" {
				t.Fatal("listed alpine image should have an ID")
			}
			if info.CachedAt.IsZero() {
				t.Fatal("listed alpine image should have cached timestamp")
			}
			found = true
			break
		}
	}

	if !found {
		t.Fatalf("expected alpine image in cache, got %+v", list)
	}
}

func TestImagesClose(t *testing.T) {
	rt := newImageTestRuntime(t)

	images, err := rt.Images()
	if err != nil {
		t.Fatalf("Images: %v", err)
	}

	if err := images.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := images.List(context.Background()); err == nil {
		t.Fatal("expected List to fail after Close")
	}
}

func TestImagesRejectedAfterRuntimeShutdown(t *testing.T) {
	rt := newImageTestRuntime(t)

	images, err := rt.Images()
	if err != nil {
		t.Fatalf("Images: %v", err)
	}
	t.Cleanup(func() {
		_ = images.Close()
	})

	if err := rt.Shutdown(context.Background(), 0); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	if _, err := rt.Images(); err == nil {
		t.Fatal("expected Images to fail after Shutdown")
	} else if !IsStopped(err) {
		t.Fatalf("expected stopped error from Images after Shutdown, got: %v", err)
	}

	if _, err := images.Pull(context.Background(), "alpine:latest"); err == nil {
		t.Fatal("expected Pull to fail after Shutdown")
	} else if !IsStopped(err) {
		t.Fatalf("expected stopped error from Pull after Shutdown, got: %v", err)
	}
}

func TestImagesRejectedAfterRuntimeClose(t *testing.T) {
	rt := newImageTestRuntime(t)

	images, err := rt.Images()
	if err != nil {
		t.Fatalf("Images: %v", err)
	}
	t.Cleanup(func() {
		_ = images.Close()
	})

	if err := rt.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := images.Pull(context.Background(), "alpine:latest"); err == nil {
		t.Fatal("expected Pull to fail after Close")
	} else if !IsStopped(err) {
		t.Fatalf("expected stopped error from Pull after Close, got: %v", err)
	}
}
