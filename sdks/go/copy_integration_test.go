//go:build boxlite_dev

package boxlite

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestIntegrationCopyOptions proves the Go SDK's CopyOption plumbing reaches
// the core through the C FFI struct (CBoxCopyOptions):
//   - default include_parent=true keeps the source dir name (the aligned
//     docker-cp default; the C/Go default used to be false=flatten)
//   - WithIncludeParent(false) flattens
//   - WithOverwrite(false) refuses to clobber an existing file
//   - copy_out round-trips with the same option semantics
//
// One box is reused across subtests because VM creation dominates cost.
func TestIntegrationCopyOptions(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))
	ctx := context.Background()

	// boxTest reports whether `test <flag> <path>` succeeds in the box. Uses the
	// exit code (reliable from Wait()) rather than stdout, which is subject to
	// the SDK's async stdout-pump race and can arrive empty.
	boxTest := func(flag, p string) bool {
		r, err := box.Exec(ctx, "test", flag, p)
		if err != nil {
			t.Fatalf("exec test %s %s: %v", flag, p, err)
		}
		return r.ExitCode == 0
	}

	srcDir := filepath.Join(t.TempDir(), "pkg")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("aaa"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("default keeps parent dir", func(t *testing.T) {
		if _, err := box.Exec(ctx, "mkdir", "-p", "/root/d1"); err != nil {
			t.Fatal(err)
		}
		if err := box.CopyInto(ctx, srcDir, "/root/d1"); err != nil {
			t.Fatalf("CopyInto: %v", err)
		}
		if !boxTest("-f", "/root/d1/pkg/a.txt") {
			t.Errorf("default include_parent: want /root/d1/pkg/a.txt to be a file")
		}
	})

	t.Run("WithIncludeParent(false) flattens", func(t *testing.T) {
		if _, err := box.Exec(ctx, "mkdir", "-p", "/root/d2"); err != nil {
			t.Fatal(err)
		}
		if err := box.CopyInto(ctx, srcDir, "/root/d2", WithIncludeParent(false)); err != nil {
			t.Fatalf("CopyInto flatten: %v", err)
		}
		if !boxTest("-f", "/root/d2/a.txt") {
			t.Errorf("flatten: want /root/d2/a.txt to be a file")
		}
		if boxTest("-e", "/root/d2/pkg") {
			t.Errorf("flatten: /root/d2/pkg must not exist (no parent dir wrapper)")
		}
	})

	t.Run("WithOverwrite(false) rejects existing", func(t *testing.T) {
		if _, err := box.Exec(ctx, "sh", "-c", "printf orig >/root/ov.txt"); err != nil {
			t.Fatal(err)
		}
		hostFile := filepath.Join(t.TempDir(), "new.txt")
		if err := os.WriteFile(hostFile, []byte("new"), 0o644); err != nil {
			t.Fatal(err)
		}
		err := box.CopyInto(ctx, hostFile, "/root/ov.txt", WithOverwrite(false))
		if err == nil {
			t.Errorf("WithOverwrite(false): expected error copying onto existing file")
		}
		// Exit-code assertion: original content must still be exactly "orig".
		r, execErr := box.Exec(ctx, "sh", "-c", `test "$(cat /root/ov.txt)" = orig`)
		if execErr != nil {
			t.Fatal(execErr)
		}
		if r.ExitCode != 0 {
			t.Errorf("WithOverwrite(false): original file must be unchanged (still 'orig')")
		}
	})

	t.Run("copy_out single file to exact path", func(t *testing.T) {
		if _, err := box.Exec(ctx, "sh", "-c", "printf boxdata >/root/out.txt"); err != nil {
			t.Fatal(err)
		}
		hostDst := filepath.Join(t.TempDir(), "out.txt")
		if err := box.CopyOut(ctx, "/root/out.txt", hostDst); err != nil {
			t.Fatalf("CopyOut: %v", err)
		}
		fi, err := os.Stat(hostDst)
		if err != nil || fi.IsDir() {
			t.Fatalf("copy_out: want regular file at %s, stat=%v err=%v", hostDst, fi, err)
		}
		b, _ := os.ReadFile(hostDst)
		if string(b) != "boxdata" {
			t.Errorf("copy_out content: want boxdata, got %q", string(b))
		}
	})

	t.Run("follow_symlinks: default preserves, WithFollowSymlinks derefs", func(t *testing.T) {
		lk := filepath.Join(t.TempDir(), "lk")
		if err := os.MkdirAll(lk, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(lk, "target.txt"), []byte("data"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("target.txt", filepath.Join(lk, "link.txt")); err != nil {
			t.Fatal(err)
		}

		// Default (follow_symlinks=false): the symlink is preserved as a link.
		if _, err := box.Exec(ctx, "mkdir", "-p", "/root/lkdef"); err != nil {
			t.Fatal(err)
		}
		if err := box.CopyInto(ctx, lk, "/root/lkdef"); err != nil {
			t.Fatalf("CopyInto default: %v", err)
		}
		if !boxTest("-L", "/root/lkdef/lk/link.txt") {
			t.Errorf("default: link.txt should remain a symlink")
		}

		// WithFollowSymlinks(true): the link is dereferenced into a regular file.
		if _, err := box.Exec(ctx, "mkdir", "-p", "/root/lkfol"); err != nil {
			t.Fatal(err)
		}
		if err := box.CopyInto(ctx, lk, "/root/lkfol", WithFollowSymlinks(true)); err != nil {
			t.Fatalf("CopyInto follow: %v", err)
		}
		if boxTest("-L", "/root/lkfol/lk/link.txt") {
			t.Errorf("follow: link.txt should be dereferenced, not a symlink")
		}
		if !boxTest("-f", "/root/lkfol/lk/link.txt") {
			t.Errorf("follow: link.txt should be a regular file")
		}
	})

	t.Run("WithRecursive(false) rejects a directory source", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "nr")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "x.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := box.CopyInto(ctx, dir, "/root/nr", WithRecursive(false)); err == nil {
			t.Errorf("WithRecursive(false) on a directory source must return an error")
		}
	})

	t.Run("copy_out dir default keeps parent dir", func(t *testing.T) {
		if _, err := box.Exec(ctx, "sh", "-c", "mkdir -p /root/op && printf y >/root/op/y.txt"); err != nil {
			t.Fatal(err)
		}
		hostDir := t.TempDir()
		if err := box.CopyOut(ctx, "/root/op", hostDir); err != nil {
			t.Fatalf("CopyOut: %v", err)
		}
		fi, err := os.Stat(filepath.Join(hostDir, "op", "y.txt"))
		if err != nil || fi.IsDir() {
			t.Errorf("copy_out default: want <host>/op/y.txt regular file, err=%v", err)
		}
	})

	t.Run("copy_out WithOverwrite(false) leaves host file", func(t *testing.T) {
		if _, err := box.Exec(ctx, "sh", "-c", "printf boxnew >/root/ow.txt"); err != nil {
			t.Fatal(err)
		}
		hostFile := filepath.Join(t.TempDir(), "ow.txt")
		if err := os.WriteFile(hostFile, []byte("hostold"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := box.CopyOut(ctx, "/root/ow.txt", hostFile, WithOverwrite(false)); err == nil {
			t.Errorf("copy_out WithOverwrite(false): expected error onto existing host file")
		}
		b, _ := os.ReadFile(hostFile)
		if string(b) != "hostold" {
			t.Errorf("copy_out WithOverwrite(false): host file must be unchanged, got %q", string(b))
		}
	})

	t.Run("copy_out follow_symlinks: default preserves, follow derefs", func(t *testing.T) {
		if _, err := box.Exec(ctx, "sh", "-c",
			"mkdir -p /root/lkb && printf data >/root/lkb/target.txt && ln -sf target.txt /root/lkb/link.txt"); err != nil {
			t.Fatal(err)
		}

		hostDef := t.TempDir()
		if err := box.CopyOut(ctx, "/root/lkb", hostDef); err != nil {
			t.Fatalf("CopyOut default: %v", err)
		}
		fi, err := os.Lstat(filepath.Join(hostDef, "lkb", "link.txt"))
		if err != nil || fi.Mode()&os.ModeSymlink == 0 {
			t.Errorf("copy_out default: link.txt should remain a symlink on host (mode=%v err=%v)", fi.Mode(), err)
		}

		hostFol := t.TempDir()
		if err := box.CopyOut(ctx, "/root/lkb", hostFol, WithFollowSymlinks(true)); err != nil {
			t.Fatalf("CopyOut follow: %v", err)
		}
		fi, err = os.Lstat(filepath.Join(hostFol, "lkb", "link.txt"))
		if err != nil || fi.Mode()&os.ModeSymlink != 0 {
			t.Errorf("copy_out follow: link.txt should be a regular file on host (mode=%v err=%v)", fi.Mode(), err)
		}
	})

	t.Run("copy_out WithIncludeParent(false) flattens", func(t *testing.T) {
		if _, err := box.Exec(ctx, "sh", "-c", "mkdir -p /root/odf && printf z >/root/odf/z.txt"); err != nil {
			t.Fatal(err)
		}
		hostDir := t.TempDir()
		if err := box.CopyOut(ctx, "/root/odf", hostDir, WithIncludeParent(false)); err != nil {
			t.Fatalf("CopyOut flatten: %v", err)
		}
		// Contents land directly in hostDir, not under an odf/ wrapper.
		if fi, err := os.Stat(filepath.Join(hostDir, "z.txt")); err != nil || fi.IsDir() {
			t.Errorf("copy_out flatten: want <host>/z.txt regular file, err=%v", err)
		}
		if _, err := os.Stat(filepath.Join(hostDir, "odf")); err == nil {
			t.Errorf("copy_out flatten: <host>/odf wrapper must not exist")
		}
	})
}
