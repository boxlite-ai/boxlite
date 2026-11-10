package boxlite

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCheckpointArchivePreparationValidatesArgumentsBeforeNativeSubmission(t *testing.T) {
	source := CheckpointArchiveSource{Path: "archive.boxlite", SHA256: strings.Repeat("a", 64), PinnedImage: "example/app@sha256:" + strings.Repeat("b", 64)}
	for _, name := range []string{"path", "sha", "image"} {
		for _, invalid := range []string{"", "value\x00ignored"} {
			candidate := source
			switch name {
			case "path":
				candidate.Path = invalid
			case "sha":
				candidate.SHA256 = invalid
			case "image":
				candidate.PinnedImage = invalid
			}
			if _, err := (&Runtime{}).PrepareCheckpointArchive(context.Background(), candidate, nil); !IsInvalidArgument(err) {
				t.Fatalf("%s %q: expected invalid argument, got %v", name, invalid, err)
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Runtime{}).PrepareCheckpointArchive(ctx, source, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled preparation: %v", err)
	}
}

func TestCheckpointArchivePreparationOnRestNeverSendsLocalArchivePaths(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	_, err = runtime.PrepareCheckpointArchive(context.Background(), CheckpointArchiveSource{Path: "/private/checkpoint.boxlite", SHA256: strings.Repeat("a", 64), PinnedImage: "example/app@sha256:" + strings.Repeat("b", 64)}, nil)
	var native *Error
	if !errors.As(err, &native) || native.Code != ErrUnsupported {
		t.Fatalf("expected unsupported local operation, got %v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("local archive metadata reached the REST server in %d requests", requests.Load())
	}
}

func TestCheckpointArchivePreparationRejectsUninitializedAndClosedRuntime(t *testing.T) {
	source := CheckpointArchiveSource{Path: "archive.boxlite", SHA256: strings.Repeat("a", 64), PinnedImage: "example/app@sha256:" + strings.Repeat("b", 64)}
	runtime, err := NewRest(BoxliteRestOptions{URL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []*Runtime{new(Runtime), runtime} {
		if _, err := candidate.PrepareCheckpointArchive(context.Background(), source, nil); !errors.Is(err, ErrRuntimeClosed) {
			t.Errorf("expected ErrRuntimeClosed, got %v", err)
		}
	}
}
