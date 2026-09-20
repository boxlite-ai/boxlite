package boxlite

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOverlayBDDoesNotFallBackToOCI(t *testing.T) {
	home := filepath.Join(t.TempDir(), "runtime")
	client, err := NewClient(context.Background(), ClientConfig{
		HomeDir:          home,
		OverlayBDEnabled: true,
	})
	if client != nil {
		_ = client.Close()
		t.Fatal("OverlayBD must not silently create an OCI runtime")
	}
	if err == nil || !strings.Contains(err.Error(), "BOXLITE_OVERLAYBD_IMAGE_DIR is required") {
		t.Fatal("expected an explicit missing OverlayBD image directory error")
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("invalid configuration must fail before creating the runtime home")
	}
}
