package boxlite

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKernelFeatureGateAtBoxCreate(t *testing.T) {
	for _, tc := range []struct {
		name     string
		features []string
		want     string
	}{
		{"disabled", nil, "disabled"},
		{"enabled", []string{"custom-kernel"}, "regular file"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			kernel := filepath.Join(t.TempDir(), "kernel.bin")
			if err := os.WriteFile(kernel, []byte("\x7fELFfixture"), 0600); err != nil {
				t.Fatal(err)
			}
			advanced, err := NewAdvancedBoxOptions()
			if err != nil {
				t.Fatal(err)
			}
			defer advanced.Close()
			if err := advanced.SetKernelPath(kernel); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(kernel); err != nil {
				t.Fatal(err)
			}
			rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithExperimentalFeatures(tc.features...))
			if err != nil {
				var sdkError *Error
				if errors.As(err, &sdkError) && (sdkError.Code == ErrUnsupported || sdkError.Code == ErrUnsupportedEngine) {
					t.Skipf("runtime not available: %v", err)
				}
				t.Fatal(err)
			}
			defer rt.Close()
			box, err := rt.Create(context.Background(), "alpine:3.21", WithAdvancedOptions(advanced))
			if err == nil {
				_ = rt.ForceRemove(context.Background(), box.ID())
				box.Close()
				t.Fatal("Create accepted a removed kernel file")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q, got %v", tc.want, err)
			}
		})
	}
}

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

func TestKernelExperimentalFeatures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		features []string
	}{
		{"none", nil},
		{"custom-kernel", []string{"custom-kernel"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithExperimentalFeatures(tc.features...))
			if err != nil {
				var sdkError *Error
				if errors.As(err, &sdkError) && (sdkError.Code == ErrUnsupported || sdkError.Code == ErrUnsupportedEngine) {
					t.Skipf("runtime not available: %v", err)
				}
				t.Fatal(err)
			}
			if err := rt.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}

	for _, tc := range []struct {
		name    string
		feature string
		want    string
	}{
		{"empty", "", "empty"},
		{"whitespace", " \t\n", "empty"},
		{"unknown", "unknown", "unknown feature"},
		{"NUL", "custom-kernel\x00suffix", "NUL"},
		{"comma", "custom-kernel,nested-virtualization", "comma"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithExperimentalFeatures(tc.feature))
			if err == nil {
				rt.Close()
				t.Fatalf("accepted %q", tc.feature)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q, got %v", tc.want, err)
			}
		})
	}
}
