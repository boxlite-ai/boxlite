package boxlite

import (
	"testing"
	"time"
)

// REST runtime construction performs no network I/O (the HTTP
// connection is lazy), so these are unit tests: they cross the CGO
// boundary into the opaque credential + options FFI
// (boxlite_rest_options_new / _set_credential / _set_prefix /
// boxlite_rest_runtime_new_with_options) and verify the runtime is
// constructed and freed.

func TestNewRestURLOnly(t *testing.T) {
	rt, err := NewRest(BoxliteRestOptions{URL: "http://localhost:8100"})
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

func TestNewRestWithCredentialAndPrefix(t *testing.T) {
	rt, err := NewRest(BoxliteRestOptions{
		URL:        "https://api.example.com",
		Credential: NewApiKeyCredential("blk_live_example"),
		Prefix:     "v1",
	})
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

// ApiKeyCredential must satisfy the Credential interface and yield a
// never-expiring token carrying the key verbatim.
func TestApiKeyCredentialGetToken(t *testing.T) {
	var cred Credential = NewApiKeyCredential("blk_live_x")
	tok := cred.GetToken()
	if tok.Token != "blk_live_x" {
		t.Errorf("GetToken().Token: got %q, want %q", tok.Token, "blk_live_x")
	}
	if tok.ExpiresAt != nil {
		t.Errorf("GetToken().ExpiresAt: got %v, want nil (API keys never expire)", tok.ExpiresAt)
	}
}

func TestApiKeyCredentialFromEnv(t *testing.T) {
	t.Setenv("BOXLITE_API_KEY", "")
	if _, ok := ApiKeyCredentialFromEnv(); ok {
		t.Error("ApiKeyCredentialFromEnv: expected ok=false when BOXLITE_API_KEY is empty")
	}

	t.Setenv("BOXLITE_API_KEY", "blk_live_env")
	cred, ok := ApiKeyCredentialFromEnv()
	if !ok {
		t.Fatal("ApiKeyCredentialFromEnv: expected ok=true when BOXLITE_API_KEY is set")
	}
	if got := cred.GetToken().Token; got != "blk_live_env" {
		t.Errorf("ApiKeyCredentialFromEnv token: got %q, want %q", got, "blk_live_env")
	}
}

// A non-ApiKeyCredential implementation must be rejected with a clear
// error (only *ApiKeyCredential crosses the FFI today).
type unsupportedCredential struct{}

func (unsupportedCredential) GetToken() AccessToken {
	return AccessToken{Token: "x", ExpiresAt: &time.Time{}}
}

func TestNewRestUnsupportedCredentialRejected(t *testing.T) {
	_, err := NewRest(BoxliteRestOptions{
		URL:        "https://api.example.com",
		Credential: unsupportedCredential{},
	})
	if err == nil {
		t.Fatal("NewRest with unsupported credential: expected error, got nil")
	}
}

// Idempotent double-Close must not panic or error (mirrors Runtime
// semantics from NewRuntime).
func TestNewRestDoubleCloseSafe(t *testing.T) {
	rt, err := NewRest(BoxliteRestOptions{
		URL:        "http://localhost:8100",
		Credential: NewApiKeyCredential("k"),
	})
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
