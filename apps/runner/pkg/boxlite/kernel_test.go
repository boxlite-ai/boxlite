package boxlite

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestKernelPathRejectsInvalidOperatorConfiguration(t *testing.T) {
	for _, path := range []string{"relative/kernel", filepath.Join(t.TempDir(), "missing"), t.TempDir()} {
		client, err := NewClient(context.Background(), ClientConfig{HomeDir: t.TempDir(), KernelPath: path})
		if err == nil {
			client.Close()
			t.Fatalf("accepted %q", path)
		}
		if !strings.Contains(err.Error(), "BOXLITE_KERNEL_PATH") {
			t.Fatal(err)
		}
	}
}
