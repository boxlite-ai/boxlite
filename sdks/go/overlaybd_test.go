package boxlite

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestOverlayBDCloudConstructorRejectsMissingDirectory(t *testing.T) {
	home := filepath.Join(t.TempDir(), "runtime")
	rt, err := NewCloudRunner(true, "", WithHomeDir(home))
	if rt != nil {
		rt.Close()
		t.Fatal("missing directory unexpectedly accepted")
	}
	if err == nil || !strings.Contains(err.Error(), "image directory") {
		t.Fatalf("expected missing directory error, got %v", err)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("invalid configuration created runtime state")
	}
}

// Requires a real converted Linux image, UBLK daemon and BoxLite VM runtime.
// make test:integration:overlaybd validates prerequisites before invoking this.
func TestOverlayBDLocalSmoke(t *testing.T) {
	image, directory := os.Getenv("OVERLAYBD_TEST_IMAGE"), os.Getenv("BOXLITE_OVERLAYBD_IMAGE_DIR")
	if runtime.GOOS != "linux" || image == "" || directory == "" {
		t.Skip("real Linux OverlayBD fixture is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	home := t.TempDir()
	rt, err := NewCloudRunner(true, directory, WithHomeDir(home))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rt.Close() })
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/overlaybd-ublk/ublkd.sock")
		},
	}}
	defer client.CloseIdleConnections()
	devices := func(want int) {
		t.Helper()
		response, err := client.Get("http://localhost/v1/list")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var list struct {
			OK      bool `json:"ok"`
			Devices []struct {
				Config string `json:"config"`
			} `json:"devices"`
		}
		if err := json.NewDecoder(response.Body).Decode(&list); err != nil {
			t.Fatal(err)
		}
		if !list.OK {
			t.Fatal("daemon list failed")
		}
		count := 0
		for _, d := range list.Devices {
			if strings.HasPrefix(d.Config, home+"/overlaybd/devices/") {
				count++
			}
		}
		if count != want {
			t.Fatalf("owned devices: got %d, want %d", count, want)
		}
	}
	create := func() *Box {
		t.Helper()
		box, err := rt.Create(ctx, image, WithAutoRemove(false), WithEntrypoint("/bin/sh"), WithCmd("-c", "sleep 600"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := box.Stop(cleanup); err != nil {
				t.Error(err)
			}
			if err := rt.Remove(cleanup, box.ID()); err != nil {
				t.Error(err)
			}
			box.Close()
		})
		if err := box.Start(ctx); err != nil {
			t.Fatal(err)
		}
		return box
	}
	exec := func(box *Box, script string) {
		t.Helper()
		result, err := box.Exec(ctx, "/bin/sh", "-c", script)
		if err != nil {
			t.Fatal(err)
		}
		if result.ExitCode != 0 {
			t.Fatalf("guest assertion failed: %s", result.Stderr)
		}
	}
	a, b := create(), create()
	devices(1)
	exec(a, "printf a > /overlaybd-smoke-marker")
	exec(b, "test ! -e /overlaybd-smoke-marker && printf b > /overlaybd-smoke-marker")
	if err := a.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	devices(1)
	exec(b, "test \"$(cat /overlaybd-smoke-marker)\" = b")
	if err := b.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	devices(0)
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	exec(a, "test \"$(cat /overlaybd-smoke-marker)\" = a")
	if err := a.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	devices(0)
}
