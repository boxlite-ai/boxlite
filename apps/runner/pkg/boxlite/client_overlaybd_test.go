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
	if err == nil || !strings.Contains(err.Error(), "OverlayBD backend is not implemented") {
		t.Fatal("expected an explicit unsupported OverlayBD error")
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("unsupported backend must fail before creating the runtime home")
	}
}
