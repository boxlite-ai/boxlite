package boxlite

import "testing"

// REST runtime construction performs no network I/O (the HTTP
// connection is lazy), so these are unit tests: they cross the CGO
// boundary into boxlite_rest_runtime_new + boxlite_runtime_free and
// verify the handle is constructed and freed.

func TestNewRestURLOnly(t *testing.T) {
	rt, err := NewRest("http://localhost:8100")
	if err != nil {
		t.Fatalf("NewRest(url) returned error: %v", err)
	}
	if rt == nil {
		t.Fatal("NewRest(url) returned nil runtime")
	}
	if err := rt.Close(); err != nil {
		t.Fatalf("Close() returned error: %v", err)
	}
}

func TestNewRestWithApiKeyAndPrefix(t *testing.T) {
	rt, err := NewRest(
		"https://api.example.com",
		WithApiKey("blk_live_example"),
		WithPrefix("v1"),
	)
	if err != nil {
		t.Fatalf("NewRest with credential+prefix returned error: %v", err)
	}
	if rt == nil {
		t.Fatal("NewRest with credential+prefix returned nil runtime")
	}
	if err := rt.Close(); err != nil {
		t.Fatalf("Close() returned error: %v", err)
	}
}

func TestRestOptionsAccumulate(t *testing.T) {
	cfg := &restConfig{}
	for _, o := range []RestOption{WithApiKey("k"), WithPrefix("v2")} {
		o(cfg)
	}
	if cfg.apiKey != "k" {
		t.Errorf("WithApiKey: got %q, want %q", cfg.apiKey, "k")
	}
	if cfg.prefix != "v2" {
		t.Errorf("WithPrefix: got %q, want %q", cfg.prefix, "v2")
	}
}

// Idempotent double-Close must not panic or error (mirrors Runtime
// semantics from NewRuntime).
func TestNewRestDoubleCloseSafe(t *testing.T) {
	rt, err := NewRest("http://localhost:8100", WithApiKey("k"))
	if err != nil {
		t.Fatalf("NewRest returned error: %v", err)
	}
	if err := rt.Close(); err != nil {
		t.Fatalf("first Close() returned error: %v", err)
	}
	if err := rt.Close(); err != nil {
		t.Fatalf("second Close() returned error: %v", err)
	}
}
