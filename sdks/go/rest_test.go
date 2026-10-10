package boxlite

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// REST runtime construction performs no network I/O (the HTTP
// connection is lazy), so these are unit tests: they cross the CGO
// boundary into the opaque credential + options FFI
// (boxlite_rest_options_new / _set_credential / _set_path_prefix
// / boxlite_rest_runtime_new_with_options) and verify the runtime is
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

func TestNewRestWithCredentialAndPathPrefix(t *testing.T) {
	rt, err := NewRest(BoxliteRestOptions{
		URL:        "https://api.example.com",
		Credential: NewApiKeyCredential("blk_live_example"),
		PathPrefix: "acme",
	})
	if err != nil {
		t.Fatalf("NewRest with credential+path_prefix returned error: %v", err)
	}
	if rt == nil {
		t.Fatal("NewRest with credential+path_prefix returned nil runtime")
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

func TestRestBoxInfoFetchesCurrentMetadata(t *testing.T) {
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/boxes/box1" {
			http.NotFound(w, r)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if requestCount.Add(1) == 1 {
			_, _ = io.WriteString(w, `{
				"box_id":"box1","name":"service","status":"configured",
				"created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z",
				"pid":null,"image":"alpine:3.20","cpus":1,"memory_mib":256
			}`)
			return
		}

		_, _ = io.WriteString(w, `{
			"box_id":"box1","name":"service","status":"stopped",
			"created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-15T00:00:00Z",
			"pid":null,"image":"alpine:3.21","cpus":2,"memory_mib":768,
			"auto_stop":42,"auto_delete":7,"auto_resume":false
		}`)
	}))
	defer server.Close()

	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	defer func() {
		if err := rt.Close(); err != nil {
			t.Errorf("Close runtime: %v", err)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	box, err := rt.Get(ctx, "box1")
	if err != nil {
		t.Fatalf("Get box: %v", err)
	}
	defer func() {
		if err := box.Close(); err != nil {
			t.Errorf("Close box: %v", err)
		}
	}()

	info, err := box.Info(ctx)
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if got := requestCount.Load(); got != 2 {
		t.Fatalf("request count: got %d, want 2", got)
	}
	if info.ID != "box1" || info.Name != "service" {
		t.Errorf("identity: got ID=%q Name=%q", info.ID, info.Name)
	}
	if info.State != StateStopped || info.Running {
		t.Errorf("state: got State=%q Running=%v", info.State, info.Running)
	}
	if info.Image != "alpine:3.21" || info.CPUs != 2 || info.MemoryMiB != 768 {
		t.Errorf(
			"resources: got Image=%q CPUs=%d MemoryMiB=%d",
			info.Image,
			info.CPUs,
			info.MemoryMiB,
		)
	}
	if info.AutoStop != 42 || info.AutoDelete != 7 || info.AutoResume {
		t.Errorf(
			"lifecycle: got AutoStop=%d AutoDelete=%d AutoResume=%v",
			info.AutoStop,
			info.AutoDelete,
			info.AutoResume,
		)
	}
}

func TestRestNetworkSetInboundPutsMode(t *testing.T) {
	const boxJSON = `{
		"box_id":"box1","name":"service","status":"running",
		"created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z",
		"pid":null,"image":"alpine:3.20","cpus":1,"memory_mib":256
	}`
	cases := []struct {
		name         string
		capabilities string
		mode         NetworkMode
		wantPut      bool
		wantErr      string
	}{
		{name: "advertising server accepts the update", capabilities: `{"capabilities":{"inbound_update_enabled":true}}`, mode: NetworkModeDisabled, wantPut: true},
		{name: "server without the capability is refused before any PUT", capabilities: `{"capabilities":{}}`, mode: NetworkModeDisabled, wantErr: "unsupported"},
		{name: "unknown mode is rejected before any request", capabilities: `{"capabilities":{"inbound_update_enabled":true}}`, mode: NetworkMode("public"), wantErr: `invalid inbound network mode "public"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var putBody atomic.Pointer[string]
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/box1":
					_, _ = io.WriteString(w, boxJSON)
				case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
					_, _ = io.WriteString(w, tc.capabilities)
				case r.Method == http.MethodPut && r.URL.Path == "/v1/boxes/box1/network/inbound":
					body, _ := io.ReadAll(r.Body)
					text := string(body)
					putBody.Store(&text)
					_, _ = io.WriteString(w, `{"mode":"disabled"}`)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatalf("NewRest: %v", err)
			}
			defer func() { _ = rt.Close() }()

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			box, err := rt.Get(ctx, "box1")
			if err != nil {
				t.Fatalf("Get box: %v", err)
			}
			defer func() { _ = box.Close() }()
			network, err := box.Network()
			if err != nil {
				t.Fatalf("Network: %v", err)
			}
			defer func() { _ = network.Close() }()

			err = network.SetInbound(ctx, tc.mode)
			if tc.wantPut {
				if err != nil {
					t.Fatalf("SetInbound: %v", err)
				}
				got := putBody.Load()
				if got == nil || !strings.Contains(*got, `"disabled"`) {
					t.Fatalf("PUT body = %v, want mode disabled", got)
				}
				return
			}
			if putBody.Load() != nil {
				t.Fatalf("PUT was sent although SetInbound had to refuse: %v", tc.name)
			}
			if tc.wantErr == "unsupported" {
				var berr *Error
				if !errors.As(err, &berr) || berr.Code != ErrUnsupported {
					t.Fatalf("SetInbound error = %v, want ErrUnsupported", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("SetInbound error = %v, want %q", err, tc.wantErr)
			}
		})
	}
}
