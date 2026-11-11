package boxlite

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestPreparedImportValidatesArgumentsBeforeNativeSubmission(t *testing.T) {
	source := "archive.boxlite"
	for _, invalid := range []string{"", "value\x00ignored"} {
		if _, err := (&Runtime{}).PrepareImport(context.Background(), invalid, ImportOptions{}); !IsInvalidArgument(err) {
			t.Fatalf("%q: expected invalid argument, got %v", invalid, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Runtime{}).PrepareImport(ctx, source, ImportOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled preparation: %v", err)
	}
}

func TestPreparedImportOnRestNeverSendsLocalArchivePaths(t *testing.T) {
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
	_, err = runtime.PrepareImport(context.Background(), "/private/archive.boxlite", ImportOptions{})
	var native *Error
	if !errors.As(err, &native) || native.Code != ErrUnsupported {
		t.Fatalf("expected unsupported local operation, got %v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("local archive metadata reached the REST server in %d requests", requests.Load())
	}
}

func TestPreparedImportRejectsUninitializedAndClosedRuntime(t *testing.T) {
	source := "archive.boxlite"
	runtime, err := NewRest(BoxliteRestOptions{URL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []*Runtime{new(Runtime), runtime} {
		if _, err := candidate.PrepareImport(context.Background(), source, ImportOptions{}); !errors.Is(err, ErrRuntimeClosed) {
			t.Errorf("expected ErrRuntimeClosed, got %v", err)
		}
	}
}

func TestPreparedImportRejectsClosingAndCancelledSubmission(t *testing.T) {
	runtime, err := NewRest(BoxliteRestOptions{URL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	source := "archive.boxlite"
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	ctx := &cancelBetweenErrChecksContext{Context: base, sampled: make(chan struct{}), resume: release}
	done := make(chan error, 1)
	go func() { _, err := runtime.PrepareImport(ctx, source, ImportOptions{}); done <- err }()
	select {
	case <-ctx.sampled:
	case <-time.After(time.Second):
		t.Fatal("preparation did not validate context")
	}
	cancel()
	close(release)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("second admission check lost cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled submission did not return")
	}
	runtime.closingOnce.Do(func() { close(runtime.closing) })
	if _, err := runtime.PrepareImport(context.Background(), source, ImportOptions{}); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("closing preparation: %v", err)
	}
}
