//go:build boxlite_coverage

package nativeprofile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFlushInitializesFilenameAndReportsWriteErrors(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "native.profraw")
	t.Setenv("LLVM_PROFILE_FILE", filename)
	if !Flush() {
		t.Fatal("native profile flush failed before writing the configured file")
	}
	info, err := os.Stat(filename)
	if err != nil || info.Size() == 0 {
		t.Fatalf("configured native profile was not written: %v", err)
	}
	t.Setenv("LLVM_PROFILE_FILE", directory)
	if Flush() {
		t.Fatal("native profile flush hid a write error")
	}
}
