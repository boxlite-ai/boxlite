package boxlite

import (
	"context"
	"errors"
	"testing"
)

func TestBoxGitRejectsClosedHandle(t *testing.T) {
	var box *Box
	if _, err := box.Git(); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Git() error = %v, want ErrRuntimeClosed", err)
	}
}

func TestGitMethodsRejectClosedHandle(t *testing.T) {
	var git *Git
	ctx := context.Background()
	if _, err := git.Status(ctx, "/tmp/repo"); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Status() error = %v, want ErrRuntimeClosed", err)
	}
	if _, err := git.Branches(ctx, "/tmp/repo"); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Branches() error = %v, want ErrRuntimeClosed", err)
	}
	if err := git.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}
