package boxlite

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKernelPathSetter(t *testing.T) {
	advanced, err := NewAdvancedBoxOptions()
	if err != nil {
		t.Fatal(err)
	}
	defer advanced.Close()
	path := filepath.Join(t.TempDir(), "kernel.bin")
	if err := os.WriteFile(path, []byte("\x7fELFfixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := advanced.SetKernelPath(path); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"", "relative", path + "\x00suffix", path + ".missing"} {
		if err := advanced.SetKernelPath(invalid); err == nil {
			t.Errorf("accepted %q", invalid)
		}
	}
	advanced.Close()
	if err := advanced.SetKernelPath(path); err == nil {
		t.Fatal("accepted a closed handle")
	}
}

func TestKernelExperimentalFeaturesRejectInvalidInput(t *testing.T) {
	for _, feature := range []string{"custom-kernel,unknown", "custom-kernel\x00,unknown"} {
		rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithExperimentalFeatures(feature))
		if err == nil {
			rt.Close()
			t.Fatalf("accepted %q", feature)
		}
		if !strings.Contains(err.Error(), "unknown") && !strings.Contains(err.Error(), "NUL") {
			t.Fatal(err)
		}
	}
}
