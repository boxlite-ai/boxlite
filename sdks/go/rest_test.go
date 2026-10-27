package boxlite

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
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

// imageReply is what the catalog answers one request with.
type imageReply struct {
	status int
	body   string
}

const (
	oldDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	newDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// imageCatalog is a server answering the box API's image routes with fixed
// replies. It matches the raw request target, so a name sent as three path
// segments instead of one reaches no route. A request's body, when it has
// one, is recorded after its target.
type imageCatalog struct {
	*httptest.Server
	mu       sync.Mutex
	replies  map[string]imageReply
	requests []string
	// Set by holdReplies: each request is reported on arrived, then kept open
	// until release closes.
	arrived chan string
	release chan struct{}
}

func newImageCatalog(t *testing.T) *imageCatalog {
	t.Helper()
	catalog := &imageCatalog{replies: map[string]imageReply{
		"DELETE /v1/images/quay.io%2Facme%2Fapp/aliases/stable": {status: http.StatusNoContent},
		"GET /v1/images/quay.io%2Facme%2Fapp": {http.StatusOK, `{
			"name":"quay.io/acme/app","aliases":["v1","v2"],"curated":true,
			"versions":[
				{"digest":"sha256:bb","size_bytes":4096,"source_ref":"quay.io/acme/app:v2",
				 "recorded_at":"2026-09-01T00:00:00Z"},
				{"digest":"sha256:aa","size_bytes":null,"source_ref":"quay.io/acme/app:v1",
				 "recorded_at":"2026-08-15T12:30:00Z"}
			]
		}`},
		// An operator-provided image: the cloud has recorded no build of it.
		"GET /v1/images/base":                    {http.StatusOK, `{"name":"base","aliases":[],"curated":true,"versions":[]}`},
		"GET /v1/images/usage":                   {http.StatusOK, `{"count":3,"limit":20,"known_bytes":8192}`},
		"DELETE /v1/images/quay.io%2Facme%2Fapp": {status: http.StatusNoContent},
		"POST /v1/images/quay.io%2Facme%2Fapp/aliases": {http.StatusCreated, `{
			"name":"quay.io/acme/app","aliases":["stable"],"curated":false,
			"versions":[
				{"digest":"` + newDigest + `","size_bytes":null,"source_ref":"quay.io/acme/app:v2",
				 "recorded_at":"2026-09-01T00:00:00Z","aliases":["stable"],
				 "last_used_at":"2026-09-02T00:00:00Z","upstream_missing_at":null}
			],
			"history":[
				{"alias":"stable","from_digest":"` + oldDigest + `","to_digest":"` + newDigest + `",
				 "actor":"user-1","recorded_at":"2026-09-03T00:00:00Z"},
				{"alias":"stable","from_digest":null,"to_digest":"` + oldDigest + `",
				 "actor":null,"recorded_at":"2026-08-15T12:30:00Z"}
			]
		}`},
	}}
	catalog.Server = httptest.NewServer(http.HandlerFunc(catalog.serve))
	t.Cleanup(catalog.Close)
	return catalog
}

func (c *imageCatalog) serve(w http.ResponseWriter, r *http.Request) {
	request := r.Method + " " + r.RequestURI
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	c.mu.Lock()
	c.requests = append(c.requests, strings.TrimSpace(request+" "+string(body)))
	reply, ok := c.replies[request]
	arrived, release := c.arrived, c.release
	c.mu.Unlock()

	if release != nil {
		select {
		case arrived <- request:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	if reply.body != "" {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(reply.status)
	_, _ = io.WriteString(w, reply.body)
}

// answer replaces the catalog's reply to request.
func (c *imageCatalog) answer(request string, reply imageReply) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.replies[request] = reply
}

// holdReplies keeps every request open until release runs, so a caller can
// give up on a call the server has not answered yet. The first request held
// is reported on arrived.
func (c *imageCatalog) holdReplies(t *testing.T) (arrived <-chan string, release func()) {
	t.Helper()
	gate := make(chan struct{})
	reported := make(chan string, 1)
	c.mu.Lock()
	c.arrived, c.release = reported, gate
	c.mu.Unlock()
	var once sync.Once
	release = func() { once.Do(func() { close(gate) }) }
	t.Cleanup(release)
	return reported, release
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
	if !reflect.DeepEqual(detail.Aliases, []string{"v1", "v2"}) {
		t.Errorf("Aliases: got %q", detail.Aliases)
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

func TestRestImagesGetOfACuratedImageHasNoBuilds(t *testing.T) {
	catalog := newImageCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	detail, err := catalog.images(t).Get(ctx, "base")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if detail.Name != "base" || !detail.Curated {
		t.Errorf("Name=%q Curated=%v", detail.Name, detail.Curated)
	}
	if len(detail.Aliases) != 0 || len(detail.Versions) != 0 {
		t.Errorf("Aliases=%q Versions=%+v, want neither", detail.Aliases, detail.Versions)
	}
}

func requireErrorCode(t *testing.T, err error, code ErrorCode, inMessage string) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("got %v, want code %d", err, code)
	}
	if !strings.Contains(e.Message, inMessage) {
		t.Fatalf("message %q does not mention %q", e.Message, inMessage)
	}
}

// A refusal reaches the caller with the class the server's reply names and
// the server's own sentence. The bodies are the two envelopes servers send:
// the cloud API's flat one and `boxlite serve`'s nested one.
func TestRestImagesCarryTheServersRefusal(t *testing.T) {
	getApp := func(ctx context.Context, images *Images) error {
		_, err := images.Get(ctx, "quay.io/acme/app")
		return err
	}
	tests := []struct {
		name     string
		request  string
		reply    imageReply
		call     func(context.Context, *Images) error
		wantCode ErrorCode
		wantText string
	}{
		{
			name:    "get of a name the catalog does not hold",
			request: "GET /v1/images/quay.io%2Facme%2Fapp",
			reply: imageReply{http.StatusNotFound,
				`{"statusCode":404,"error":"Not Found","message":"Image 'quay.io/acme/app' not found"}`},
			call:     getApp,
			wantCode: ErrNotFound,
			wantText: "Image 'quay.io/acme/app' not found",
		},
		{
			name:    "remove while a box can still boot from the image",
			request: "DELETE /v1/images/quay.io%2Facme%2Fapp",
			reply: imageReply{http.StatusConflict,
				`{"statusCode":409,"error":"Conflict","message":"Image 'quay.io/acme/app' is in use by box b1"}`},
			call: func(ctx context.Context, images *Images) error {
				return images.Remove(ctx, "quay.io/acme/app")
			},
			wantCode: ErrInvalidState,
			wantText: "in use by box b1",
		},
		{
			name:    "usage from a server whose runtime has no allowance",
			request: "GET /v1/images/usage",
			reply: imageReply{http.StatusBadRequest,
				`{"error":{"message":"an embedded runtime has a local cache with no limit",` +
					`"type":"UnsupportedError","code":"unsupported"}}`},
			call: func(ctx context.Context, images *Images) error {
				_, err := images.Usage(ctx)
				return err
			},
			wantCode: ErrUnsupported,
			wantText: "an embedded runtime has a local cache with no limit",
		},
		{
			name:    "get when the server fails",
			request: "GET /v1/images/quay.io%2Facme%2Fapp",
			reply: imageReply{http.StatusInternalServerError,
				`{"statusCode":500,"error":"Internal Server Error","message":"An unexpected error occurred."}`},
			call:     getApp,
			wantCode: ErrInternal,
			wantText: "An unexpected error occurred.",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			catalog := newImageCatalog(t)
			catalog.answer(test.request, test.reply)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			err := test.call(ctx, catalog.images(t))

			requireErrorCode(t, err, test.wantCode, test.wantText)
		})
	}
}

func TestRestImagesGetRefusesATaggedReferenceWithoutAskingTheServer(t *testing.T) {
	catalog := newImageCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := catalog.images(t).Get(ctx, "quay.io/acme/app:v1")

	requireErrorCode(t, err, ErrInvalidArgument, "such as 'quay.io/acme/app'")
	if got := catalog.received(); len(got) != 0 {
		t.Errorf("requests: got %q, want none", got)
	}
}

// imageCatalogCalls are the image handle's catalog calls, each reduced to its
// error.
var imageCatalogCalls = []struct {
	name string
	call func(context.Context, *Images) error
}{
	{"Get", func(ctx context.Context, images *Images) error {
		_, err := images.Get(ctx, "quay.io/acme/app")
		return err
	}},
	{"Remove", func(ctx context.Context, images *Images) error {
		return images.Remove(ctx, "quay.io/acme/app")
	}},
	{"Usage", func(ctx context.Context, images *Images) error {
		_, err := images.Usage(ctx)
		return err
	}},
	{"CreateAlias", func(ctx context.Context, images *Images) error {
		_, err := images.CreateAlias(ctx, "quay.io/acme/app", "stable", newDigest)
		return err
	}},
	{"DeleteAlias", func(ctx context.Context, images *Images) error {
		return images.DeleteAlias(ctx, "quay.io/acme/app", "stable")
	}},
}

func TestRestImagesDeleteAliasRemovesOnlyTheBinding(t *testing.T) {
	catalog := newImageCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := catalog.images(t).DeleteAlias(ctx, "quay.io/acme/app", "stable"); err != nil {
		t.Fatal(err)
	}
	want := []string{"DELETE /v1/images/quay.io%2Facme%2Fapp/aliases/stable"}
	if got := catalog.received(); !reflect.DeepEqual(got, want) {
		t.Fatalf("requests: %q", got)
	}
}

// callInBackground starts call and returns where its error will arrive.
func callInBackground(ctx context.Context, images *Images, call func(context.Context, *Images) error) <-chan error {
	result := make(chan error, 1)
	go func() { result <- call(ctx, images) }()
	return result
}

func waitFor[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
	var zero T
	return zero
}

func TestRestImagesCallGivesUpWhenItsContextEndsWhilePending(t *testing.T) {
	for _, op := range imageCatalogCalls {
		t.Run(op.name, func(t *testing.T) {
			catalog := newImageCatalog(t)
			arrived, release := catalog.holdReplies(t)
			images := catalog.images(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			result := callInBackground(ctx, images, op.call)
			waitFor(t, arrived, "the request to reach the server")
			cancel()

			if err := waitFor(t, result, "the call to return"); !errors.Is(err, context.Canceled) {
				t.Fatalf("got %v, want context.Canceled", err)
			}

			// Once the server answers the abandoned call, the handle still
			// answers the next one.
			release()
			usageCtx, cancelUsage := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancelUsage()
			if _, err := images.Usage(usageCtx); err != nil {
				t.Fatalf("Usage after an abandoned %s: %v", op.name, err)
			}
		})
	}
}

func TestRestImagesCallReturnsRuntimeClosedWhenTheRuntimeClosesWhilePending(t *testing.T) {
	for _, op := range imageCatalogCalls {
		t.Run(op.name, func(t *testing.T) {
			catalog := newImageCatalog(t)
			arrived, _ := catalog.holdReplies(t)
			images := catalog.images(t)

			result := callInBackground(context.Background(), images, op.call)
			waitFor(t, arrived, "the request to reach the server")
			if err := images.runtime.Close(); err != nil {
				t.Fatalf("Close runtime: %v", err)
			}

			if err := waitFor(t, result, "the call to return"); !errors.Is(err, ErrRuntimeClosed) {
				t.Fatalf("got %v, want ErrRuntimeClosed", err)
			}
		})
	}
}

func TestRestImagesCallsAfterRuntimeCloseFailWithoutARequest(t *testing.T) {
	for _, op := range imageCatalogCalls {
		t.Run(op.name, func(t *testing.T) {
			catalog := newImageCatalog(t)
			images := catalog.images(t)
			if err := images.runtime.Close(); err != nil {
				t.Fatalf("Close runtime: %v", err)
			}

			err := op.call(context.Background(), images)

			if !IsStopped(err) {
				t.Fatalf("got %v, want a stopped error", err)
			}
			if got := catalog.received(); len(got) != 0 {
				t.Errorf("requests: got %q, want none", got)
			}
		})
	}
}

func TestRestImagesCallsOnAClosedHandleFailWithoutARequest(t *testing.T) {
	for _, op := range imageCatalogCalls {
		t.Run(op.name, func(t *testing.T) {
			catalog := newImageCatalog(t)
			images := catalog.images(t)
			if err := images.Close(); err != nil {
				t.Fatalf("Close image handle: %v", err)
			}

			err := op.call(context.Background(), images)

			requireErrorCode(t, err, ErrInvalidState, "image handle is closed")
			if got := catalog.received(); len(got) != 0 {
				t.Errorf("requests: got %q, want none", got)
			}
		})
	}
}

func TestRestImagesCreateAliasPostsTheAliasAndReadsTheImage(t *testing.T) {
	catalog := newImageCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	detail, err := catalog.images(t).CreateAlias(ctx, "quay.io/acme/app", "stable", newDigest)
	if err != nil {
		t.Fatalf("CreateAlias: %v", err)
	}

	want := []string{`POST /v1/images/quay.io%2Facme%2Fapp/aliases {"alias":"stable","digest":"` + newDigest + `"}`}
	if got := catalog.received(); !reflect.DeepEqual(got, want) {
		t.Errorf("requests: got %q, want %q", got, want)
	}
	if len(detail.Versions) != 1 {
		t.Fatalf("Versions: got %d, want 1", len(detail.Versions))
	}
	version := detail.Versions[0]
	if !reflect.DeepEqual(version.Aliases, []string{"stable"}) {
		t.Errorf("version.Aliases: got %q", version.Aliases)
	}
	if want := time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC); version.LastUsedAt == nil || !version.LastUsedAt.Equal(want) {
		t.Errorf("version.LastUsedAt: got %v, want %v", version.LastUsedAt, want)
	}
	if version.UpstreamMissingAt != nil {
		t.Errorf("version.UpstreamMissingAt: got %v, want nil", version.UpstreamMissingAt)
	}
	wantHistory := []ImageAliasEvent{
		{Alias: "stable", FromDigest: oldDigest, ToDigest: newDigest, Actor: "user-1",
			RecordedAt: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)},
		{Alias: "stable", ToDigest: oldDigest,
			RecordedAt: time.Date(2026, 8, 15, 12, 30, 0, 0, time.UTC)},
	}
	if len(detail.History) != len(wantHistory) {
		t.Fatalf("History: got %+v, want %+v", detail.History, wantHistory)
	}
	for idx, event := range detail.History {
		want := wantHistory[idx]
		if event.Alias != want.Alias || event.FromDigest != want.FromDigest ||
			event.ToDigest != want.ToDigest || event.Actor != want.Actor || !event.RecordedAt.Equal(want.RecordedAt) {
			t.Errorf("History[%d]: got %+v, want %+v", idx, event, want)
		}
	}
}
