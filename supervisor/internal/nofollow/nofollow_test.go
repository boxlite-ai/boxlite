package nofollow

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// realTemp is t.TempDir with its own symlinks resolved (macOS keeps it under
// /var, itself a link to /private/var).
func realTemp(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestOpenRootRefusesSymlinksAnywhereInThePath(t *testing.T) {
	base := realTemp(t)
	real := filepath.Join(base, "data", "uploads")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "a.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(base, "leaf-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "data"), filepath.Join(base, "parent-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "file"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	r, err := OpenRoot(real)
	if err != nil {
		t.Fatal(err)
	}
	if b, err := r.ReadFile("a.txt"); err != nil || string(b) != "hi" {
		t.Fatalf("read through the opened root: %q %v", b, err)
	}
	r.Close()

	for name, p := range map[string]string{
		"symlinked directory": filepath.Join(base, "leaf-link"),
		"symlinked parent":    filepath.Join(base, "parent-link", "uploads"),
	} {
		if _, err := OpenRoot(p); !errors.Is(err, ErrSymlink) {
			t.Errorf("%s: err = %v, want ErrSymlink", name, err)
		}
	}
	if _, err := OpenRoot(filepath.Join(base, "missing")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}
	if _, err := OpenRoot(filepath.Join(base, "file")); err == nil {
		t.Error("a regular file is not a directory")
	}
	if _, err := OpenRoot("relative"); err == nil {
		t.Error("relative paths are refused")
	}
}
