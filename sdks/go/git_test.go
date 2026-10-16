package boxlite

import (
	"context"
	"errors"
	"testing"
)

// optionalGitCString is the pure-Go pivot of GitConfigOptions: empty Scope
// or Path must become a NULL C string so the Rust side applies its
// defaults (global, no working_dir). Passing "" through would make
// GitConfigScope::parse reject the scope. These cases pin that shape.
func TestOptionalGitCString(t *testing.T) {
	t.Run("empty yields NULL", func(t *testing.T) {
		ptr, free := optionalGitCString("")
		defer free()
		if ptr != nil {
			t.Fatal("empty string must yield a NULL C string")
		}
	})

	t.Run("nil options yield empty scope and path", func(t *testing.T) {
		if gitOptScope(nil) != "" {
			t.Fatalf("nil opts Scope = %q, want empty", gitOptScope(nil))
		}
		if gitOptPath(nil) != "" {
			t.Fatalf("nil opts Path = %q, want empty", gitOptPath(nil))
		}
	})

	t.Run("non-empty round-trips", func(t *testing.T) {
		ptr, free := optionalGitCString("local")
		defer free()
		if ptr == nil {
			t.Fatal("non-empty string must yield a C string")
		}
		if got := cString(ptr); got != "local" {
			t.Fatalf("C string = %q, want local", got)
		}
	})
}

func TestBoxGitRejectsClosedHandle(t *testing.T) {
	var box *Box
	if _, err := box.Git(); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Git() error = %v, want ErrRuntimeClosed", err)
	}
}

func TestGitMethodsRejectClosedHandle(t *testing.T) {
	var git *Git
	ctx := context.Background()
	if err := git.ConfigureUser(ctx, "Bot", "bot@boxlite.ai", nil); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("ConfigureUser() error = %v, want ErrRuntimeClosed", err)
	}
	if err := git.SetConfig(ctx, "user.email", "bot@boxlite.ai", nil); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("SetConfig() error = %v, want ErrRuntimeClosed", err)
	}
	if _, err := git.GetConfig(ctx, "user.email", nil); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("GetConfig() error = %v, want ErrRuntimeClosed", err)
	}
	if err := git.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}
