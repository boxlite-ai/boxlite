package controllers

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// packDir then extractTar must round-trip a tree with a regular file, a nested
// subdir, an EMPTY dir, and a symlink — all preserved.
func TestTarRoundTripPreservesStructure(t *testing.T) {
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(src, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "sub", "b.txt"), []byte("world"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(src, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("a.txt", filepath.Join(src, "link.txt")); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if err := packDir(src, &buf); err != nil {
		t.Fatalf("packDir: %v", err)
	}
	dst := t.TempDir()
	if err := extractTar(&buf, dst); err != nil {
		t.Fatalf("extractTar: %v", err)
	}

	if got, _ := os.ReadFile(filepath.Join(dst, "a.txt")); string(got) != "hello" {
		t.Errorf("a.txt = %q, want hello", got)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "sub", "b.txt")); string(got) != "world" {
		t.Errorf("sub/b.txt = %q, want world", got)
	}
	if fi, err := os.Stat(filepath.Join(dst, "empty")); err != nil || !fi.IsDir() {
		t.Errorf("empty dir not preserved: err=%v", err)
	}
	fi, err := os.Lstat(filepath.Join(dst, "link.txt"))
	if err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("link.txt is not a symlink: mode=%v err=%v", fi.Mode(), err)
	}
	if target, _ := os.Readlink(filepath.Join(dst, "link.txt")); target != "a.txt" {
		t.Errorf("link target = %q, want a.txt", target)
	}
}

// File mode is preserved through the round-trip.
func TestTarRoundTripPreservesMode(t *testing.T) {
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "x"), []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := packDir(src, &buf); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	if err := extractTar(&buf, dst); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dst, "x"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", fi.Mode().Perm())
	}
}

// extractTar must reject entries that escape the destination dir.
func TestExtractTarRejectsPathEscape(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	content := []byte("evil")
	if err := tw.WriteHeader(&tar.Header{Name: "../escape.txt", Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatal(err)
	}
	tw.Close()

	dst := t.TempDir()
	if err := extractTar(&buf, dst); err == nil {
		t.Fatal("expected extractTar to reject ../escape.txt, got nil")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dst), "escape.txt")); err == nil {
		t.Fatal("escape.txt was written outside destination")
	}
}

// extractTar must not let a symlink entry pointing outside destDir be traversed
// by a later file entry to write on the host (tar-slip via symlink). A crafted
// upload — symlink "sub" -> <outside dir>, then regular file "sub/pwned" — must
// be rejected, and nothing may be written through the escaping link.
func TestExtractTarRejectsSymlinkEscape(t *testing.T) {
	victim := t.TempDir() // a sibling dir OUTSIDE the extraction destination
	dst := t.TempDir()

	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	// 1) a symlink whose target escapes dst (absolute, points at victim)
	if err := tw.WriteHeader(&tar.Header{Name: "sub", Linkname: victim, Mode: 0o777, Typeflag: tar.TypeSymlink}); err != nil {
		t.Fatal(err)
	}
	// 2) a file that, if "sub" were created and followed, lands in victim
	pwned := []byte("pwned")
	if err := tw.WriteHeader(&tar.Header{Name: "sub/pwned", Mode: 0o644, Size: int64(len(pwned)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(pwned); err != nil {
		t.Fatal(err)
	}
	tw.Close()

	if err := extractTar(&buf, dst); err == nil {
		t.Fatal("expected extractTar to reject the escaping symlink, got nil")
	}
	if _, err := os.Stat(filepath.Join(victim, "pwned")); err == nil {
		t.Fatal("symlink traversal wrote 'pwned' outside the destination")
	}
}
