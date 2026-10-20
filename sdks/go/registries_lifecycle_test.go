//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

var registryOperations = []struct {
	name string
	call func(*Registries, context.Context) error
}{
	{"list", func(g *Registries, ctx context.Context) error { _, err := g.List(ctx); return err }},
	{"create", func(g *Registries, ctx context.Context) error {
		_, err := g.Create(ctx, testNewLogin())
		return err
	}},
	{"remove", func(g *Registries, ctx context.Context) error { return g.Remove(ctx, testLoginID) }},
}

func TestRegistriesClosedHandlesRejectEveryOperation(t *testing.T) {
	server := newRegistryServer(t)
	closed := server.registries(t)
	if err := closed.Close(); err != nil {
		t.Fatal(err)
	}
	for _, handle := range []*Registries{nil, closed} {
		for _, operation := range registryOperations {
			t.Run(operation.name, func(t *testing.T) {
				requireErrorCode(t, operation.call(handle, registryTestContext(t)), ErrInvalidState, "closed")
			})
		}
		if err := handle.Close(); err != nil {
			t.Fatalf("repeated Close: %v", err)
		}
	}
	if requests := server.received(); len(requests) != 0 {
		t.Fatalf("closed handles sent requests: %v", requests)
	}
}

func TestRegistriesPendingOperationsReturnOnCancellationOrRuntimeClose(t *testing.T) {
	for _, operation := range registryOperations {
		for _, closeRuntime := range []bool{false, true} {
			name := operation.name + "/cancel"
			if closeRuntime {
				name = operation.name + "/close"
			}
			t.Run(name, func(t *testing.T) {
				started, release := make(chan struct{}), make(chan struct{})
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					close(started)
					select {
					case <-release:
					case <-r.Context().Done():
					}
					w.WriteHeader(http.StatusServiceUnavailable)
				}))
				defer server.Close()
				defer close(release)
				rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
				if err != nil {
					t.Fatal(err)
				}
				defer rt.Close()
				images, err := rt.Images()
				if err != nil {
					t.Fatal(err)
				}
				defer images.Close()
				handle, err := images.Registries()
				if err != nil {
					t.Fatal(err)
				}
				defer handle.Close()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan error, 1)
				go func() { done <- operation.call(handle, ctx) }()
				select {
				case <-started:
				case <-time.After(5 * time.Second):
					t.Fatal("operation never reached the server")
				}
				want := context.Canceled
				if closeRuntime {
					want = ErrRuntimeClosed
					if err := rt.Close(); err != nil {
						t.Fatal(err)
					}
				} else {
					cancel()
				}
				select {
				case err := <-done:
					if !errors.Is(err, want) {
						t.Fatalf("operation returned %v, want %v", err, want)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("pending registry operation was stranded")
				}
			})
		}
	}
}

func TestRegistriesEmptyListAndServerFailure(t *testing.T) {
	server := newRegistryServer(t)
	handle := server.registries(t)
	server.reply("GET /v1/images/registries", http.StatusOK, `{"registries":[]}`)
	logins, err := handle.List(registryTestContext(t))
	if err != nil || len(logins) != 0 {
		t.Fatalf("empty list: %v, %v", logins, err)
	}
	server.reply("GET /v1/images/registries", http.StatusForbidden, `{"message":"denied"}`)
	_, err = handle.List(registryTestContext(t))
	requireErrorCode(t, err, ErrConfig, "denied")
}
