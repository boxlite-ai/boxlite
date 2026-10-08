package boxlite

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
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

// imageCatalog is a server answering the box API's image routes with fixed
// bodies. It matches the raw request target, so a name sent as three path
// segments instead of one reaches no route.
type imageCatalog struct {
	*httptest.Server
	mu       sync.Mutex
	requests []string
}

func newImageCatalog(t *testing.T) *imageCatalog {
	t.Helper()
	routes := map[string]string{
		"GET /v1/images/quay.io%2Facme%2Fapp": `{
			"name":"quay.io/acme/app","tags":["v1","v2"],"curated":true,
			"versions":[
				{"digest":"sha256:bb","size_bytes":4096,"source_ref":"quay.io/acme/app:v2",
				 "recorded_at":"2026-09-01T00:00:00Z"},
				{"digest":"sha256:aa","size_bytes":null,"source_ref":"quay.io/acme/app:v1",
				 "recorded_at":"2026-08-15T12:30:00Z"}
			]
		}`,
		"GET /v1/images/usage": `{"count":3,"limit":20,"known_bytes":8192}`,
	}
	catalog := &imageCatalog{}
	catalog.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := r.Method + " " + r.RequestURI
		catalog.mu.Lock()
		catalog.requests = append(catalog.requests, request)
		catalog.mu.Unlock()

		if request == "DELETE /v1/images/quay.io%2Facme%2Fapp" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		body, ok := routes[request]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(catalog.Close)
	return catalog
}

func (c *imageCatalog) received() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.requests...)
}

// images opens the image handle of a REST runtime on the catalog.
func (c *imageCatalog) images(t *testing.T) *Images {
	t.Helper()
	rt, err := NewRest(BoxliteRestOptions{URL: c.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() {
		if err := rt.Close(); err != nil {
			t.Errorf("Close runtime: %v", err)
		}
	})
	images, err := rt.Images()
	if err != nil {
		t.Fatalf("Images: %v", err)
	}
	t.Cleanup(func() { _ = images.Close() })
	return images
}

func TestRestImagesGetReadsTheNameAndItsVersions(t *testing.T) {
	catalog := newImageCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	detail, err := catalog.images(t).Get(ctx, "quay.io/acme/app")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if detail.Name != "quay.io/acme/app" || !detail.Curated {
		t.Errorf("Name=%q Curated=%v", detail.Name, detail.Curated)
	}
	if !reflect.DeepEqual(detail.Tags, []string{"v1", "v2"}) {
		t.Errorf("Tags: got %q", detail.Tags)
	}
	if len(detail.Versions) != 2 {
		t.Fatalf("Versions: got %d, want 2", len(detail.Versions))
	}
	newer, older := detail.Versions[0], detail.Versions[1]
	if newer.Digest != "sha256:bb" || newer.SourceRef != "quay.io/acme/app:v2" {
		t.Errorf("newer: Digest=%q SourceRef=%q", newer.Digest, newer.SourceRef)
	}
	if newer.SizeBytes == nil || *newer.SizeBytes != 4096 {
		t.Errorf("newer.SizeBytes: got %v, want 4096", newer.SizeBytes)
	}
	if want := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC); !newer.RecordedAt.Equal(want) {
		t.Errorf("newer.RecordedAt: got %v, want %v", newer.RecordedAt, want)
	}
	if older.Digest != "sha256:aa" || older.SizeBytes != nil {
		t.Errorf("older: Digest=%q SizeBytes=%v, want sha256:aa and nil", older.Digest, older.SizeBytes)
	}
	if want := time.Date(2026, 8, 15, 12, 30, 0, 0, time.UTC); !older.RecordedAt.Equal(want) {
		t.Errorf("older.RecordedAt: got %v, want %v", older.RecordedAt, want)
	}
}

func TestRestImagesUsageReadsCountLimitAndBytes(t *testing.T) {
	catalog := newImageCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	usage, err := catalog.images(t).Usage(ctx)
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}

	if want := (ImageUsage{Count: 3, Limit: 20, KnownBytes: 8192}); *usage != want {
		t.Errorf("Usage: got %+v, want %+v", *usage, want)
	}
}

func TestRestImagesRemoveDeletesTheNameAsOneSegment(t *testing.T) {
	catalog := newImageCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := catalog.images(t).Remove(ctx, "quay.io/acme/app"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	want := []string{"DELETE /v1/images/quay.io%2Facme%2Fapp"}
	if got := catalog.received(); !reflect.DeepEqual(got, want) {
		t.Errorf("requests: got %q, want %q", got, want)
	}
}
