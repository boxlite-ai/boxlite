package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
)

const (
	secret    = "gw-secret-123"  // forward secret
	ctlSecret = "ctl-secret-456" // control secret
)

type fakeOps struct {
	deployed, activated, rolledBack []int
	restarted                       []string
	deployErr, activateErr          error
	rollbackErr, restartErr         error
}

func (f *fakeOps) Health() api.HealthResponse {
	return api.HealthResponse{OK: true, Deployment: 7, SpecVersion: 3, Services: []api.ServiceStatus{}}
}
func (f *fakeOps) Deploy(n int) error   { f.deployed = append(f.deployed, n); return f.deployErr }
func (f *fakeOps) Activate(n int) error { f.activated = append(f.activated, n); return f.activateErr }
func (f *fakeOps) Rollback(n int) error { f.rolledBack = append(f.rolledBack, n); return f.rollbackErr }
func (f *fakeOps) Restart(s string) error {
	f.restarted = append(f.restarted, s)
	return f.restartErr
}
func (f *fakeOps) Logs(source string, tail int) []api.LogLine {
	return []api.LogLine{{Source: source, Line: "tail=" + strconv.Itoa(tail)}}
}

func do(t *testing.T, g *Server, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "10.0.0.9:4321"
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	var parsed map[string]any
	if strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	}
	return rec, parsed
}

// auth is what the control plane's proxy sends; ctl what its control calls send.
func auth() map[string]string { return map[string]string{SecretHeader: secret} }
func ctl() map[string]string  { return map[string]string{ControlHeader: ctlSecret} }

func TestSecretIsMandatoryEverywhere(t *testing.T) {
	g := New(&fakeOps{}, false)
	g.SetSecrets(secret, ctlSecret)
	for _, path := range []string{"/.boxlite/sv/health", "/", "/anything/else"} {
		rec, body := do(t, g, http.MethodGet, path, "", nil)
		if rec.Code != http.StatusForbidden || body["error"] != "gateway" {
			t.Fatalf("%s without header: %d %s", path, rec.Code, rec.Body.String())
		}
		rec, _ = do(t, g, http.MethodGet, path, "", map[string]string{SecretHeader: "wrong"})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s with wrong header: %d", path, rec.Code)
		}
	}
	rec, body := do(t, g, http.MethodGet, "/.boxlite/sv/health", "", ctl())
	if rec.Code != http.StatusOK || body["ok"] != true || body["deployment"] != float64(7) || body["spec_version"] != float64(3) {
		t.Fatalf("health with header: %d %s", rec.Code, rec.Body.String())
	}
	if _, ok := body["services"].([]any); !ok {
		t.Fatalf("services must be an array: %s", rec.Body.String())
	}
	// Nothing live yet → 503, not 403.
	rec, body = do(t, g, http.MethodGet, "/", "", auth())
	if rec.Code != http.StatusServiceUnavailable || body["error"] != "no_release" {
		t.Fatalf("no release: %d %s", rec.Code, rec.Body.String())
	}
}

func TestNoSecretKeepsTheDoorShut(t *testing.T) {
	g := New(&fakeOps{}, false)
	rec, _ := do(t, g, http.MethodGet, "/.boxlite/sv/health", "", map[string]string{SecretHeader: ""})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("empty secret must reject even an empty header: %d", rec.Code)
	}
}

func TestProxyForwardsAndStripsHeaders(t *testing.T) {
	var seen http.Header
	var seenHost string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		seenHost = r.Host
		w.Header().Set("X-Backend", "yes")
		io.WriteString(w, "hello "+r.URL.Path+"?"+r.URL.RawQuery)
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	port, _ := strconv.Atoi(u.Port())

	g := New(&fakeOps{}, false)
	g.SetSecrets(secret, ctlSecret)
	g.SetTarget(port, "")

	hdr := auth()
	hdr["X-BoxLite-User-Id"] = "forged"
	hdr["X-Boxlite-User-Email"] = "forged@example.com"
	hdr["X-Forwarded-Host"] = "cp.example"
	hdr["X-Forwarded-Proto"] = "https"
	hdr["X-Forwarded-Prefix"] = "/crm"
	hdr["X-Forwarded-For"] = "203.0.113.5"
	rec, _ := do(t, g, http.MethodGet, "/api/items?x=1", "", hdr)
	if rec.Code != http.StatusOK || rec.Body.String() != "hello /api/items?x=1" || rec.Header().Get("X-Backend") != "yes" {
		t.Fatalf("proxy: %d %q %v", rec.Code, rec.Body.String(), rec.Header())
	}
	for k := range seen {
		if strings.HasPrefix(strings.ToLower(k), "x-boxlite-user-") {
			t.Fatalf("identity header %s must be stripped", k)
		}
	}
	if seen.Get(SecretHeader) != "" {
		t.Fatal("gateway secret leaked to the app")
	}
	if seen.Get("X-Forwarded-Host") != "cp.example" || seen.Get("X-Forwarded-Proto") != "https" || seen.Get("X-Forwarded-Prefix") != "/crm" {
		t.Fatalf("X-Forwarded-* not forwarded: %v", seen)
	}
	if xff := seen.Get("X-Forwarded-For"); xff != "203.0.113.5, 10.0.0.9" {
		t.Fatalf("X-Forwarded-For = %q", xff)
	}
	// httptest.NewRequest sets Host to example.com; the app must see that, not
	// the 127.0.0.1:port the proxy dialled.
	if seenHost != "example.com" {
		t.Fatalf("Host = %q, want the public host", seenHost)
	}

	// With trust enabled, the control plane's identity headers pass through.
	trusting := New(&fakeOps{}, true)
	trusting.SetSecrets(secret, ctlSecret)
	trusting.SetTarget(port, "")
	do(t, trusting, http.MethodGet, "/", "", hdr)
	if seen.Get("X-BoxLite-User-Id") != "forged" {
		t.Fatalf("trusted identity header should pass: %v", seen)
	}
}

func TestProxyBackendDown(t *testing.T) {
	backend := httptest.NewServer(http.NotFoundHandler())
	u, _ := url.Parse(backend.URL)
	port, _ := strconv.Atoi(u.Port())
	backend.Close()
	g := New(&fakeOps{}, false)
	g.SetSecrets(secret, ctlSecret)
	g.SetTarget(port, "")
	rec, body := do(t, g, http.MethodGet, "/", "", auth())
	if rec.Code != http.StatusServiceUnavailable || body["error"] != "service_unavailable" || rec.Header().Get("Retry-After") != "3" {
		t.Fatalf("backend refusing connections should be 503 + Retry-After: %d %v %s", rec.Code, rec.Header(), rec.Body.String())
	}
}

func TestStaticSPAFallback(t *testing.T) {
	root := t.TempDir()
	write := func(p, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, p), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", "<h1>spa</h1>")
	write("app.js", "console.log(1)")
	write("styles/main.css", "body{}")
	write(".env", "SECRET=1")
	write("docs/index.html", "<h1>docs</h1>")
	write("outside.txt", "outside")
	if err := os.Symlink(filepath.Join(root, "..", "nope"), filepath.Join(root, "escape.txt")); err != nil {
		t.Fatal(err)
	}

	g := New(&fakeOps{}, false)
	g.SetSecrets(secret, ctlSecret)
	g.SetTarget(0, root)

	cases := []struct {
		path  string
		code  int
		body  string
		ctype string
	}{
		{"/", 200, "<h1>spa</h1>", "text/html"},
		{"/index.html", 200, "<h1>spa</h1>", "text/html"},
		{"/about", 200, "<h1>spa</h1>", "text/html"},            // SPA route → index.html
		{"/users/42/profile", 200, "<h1>spa</h1>", "text/html"}, // deep SPA route
		{"/app.js", 200, "console.log(1)", "javascript"},
		{"/styles/main.css", 200, "body{}", "text/css"},
		{"/missing.js", 404, "", ""}, // assets with an extension never fall back
		{"/.env", 404, "", ""},       // dotfiles are never served
		{"/docs", 200, "<h1>docs</h1>", "text/html"},
		{"/docs/", 200, "<h1>docs</h1>", "text/html"},
		{"/../outside.txt", 200, "outside", "text/plain"}, // ".." is cleaned away, never walks above root
		{"/escape.txt", 404, "", ""},                      // symlink leaving root
	}
	for _, c := range cases {
		rec, _ := do(t, g, http.MethodGet, c.path, "", auth())
		if rec.Code != c.code {
			t.Fatalf("%s: code %d, want %d (%s)", c.path, rec.Code, c.code, rec.Body.String())
		}
		if c.code == 200 {
			if rec.Body.String() != c.body || !strings.Contains(rec.Header().Get("Content-Type"), c.ctype) {
				t.Fatalf("%s: body %q type %q", c.path, rec.Body.String(), rec.Header().Get("Content-Type"))
			}
		}
	}
	rec, _ := do(t, g, http.MethodPost, "/about", "", auth())
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST to static: %d", rec.Code)
	}
}

func TestControlEndpoints(t *testing.T) {
	ops := &fakeOps{}
	g := New(ops, false)
	g.SetSecrets(secret, ctlSecret)

	rec, body := do(t, g, http.MethodPost, "/.boxlite/sv/deploy", `{"deployment":3}`, ctl())
	if rec.Code != http.StatusAccepted || body["deployment"] != float64(3) || len(ops.deployed) != 1 {
		t.Fatalf("deploy: %d %s", rec.Code, rec.Body.String())
	}
	ops.deployErr = api.ErrBusy
	rec, body = do(t, g, http.MethodPost, "/.boxlite/sv/deploy", `{"deployment":4}`, ctl())
	if rec.Code != http.StatusConflict || body["error"] != "deploy_in_progress" {
		t.Fatalf("busy deploy: %d %s", rec.Code, rec.Body.String())
	}
	ops.activateErr = api.ErrNotBuilt
	rec, body = do(t, g, http.MethodPost, "/.boxlite/sv/activate", `{"deployment":4}`, ctl())
	if rec.Code != http.StatusConflict || body["error"] != "not_built" {
		t.Fatalf("activate unbuilt: %d %s", rec.Code, rec.Body.String())
	}
	ops.rollbackErr = api.ErrNoRelease
	rec, body = do(t, g, http.MethodPost, "/.boxlite/sv/rollback", `{"deployment":1}`, ctl())
	if rec.Code != http.StatusNotFound || body["error"] != "not_found_release" {
		t.Fatalf("rollback missing: %d %s", rec.Code, rec.Body.String())
	}
	rec, _ = do(t, g, http.MethodPost, "/.boxlite/sv/deploy", `{"deployment":0}`, ctl())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("deploy 0: %d", rec.Code)
	}
	rec, _ = do(t, g, http.MethodPost, "/.boxlite/sv/deploy", `{not json`, ctl())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json: %d", rec.Code)
	}
	rec, _ = do(t, g, http.MethodGet, "/.boxlite/sv/deploy", "", ctl())
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET deploy: %d", rec.Code)
	}

	rec, _ = do(t, g, http.MethodPost, "/.boxlite/sv/restart", `{"service":null}`, ctl())
	if rec.Code != http.StatusOK || ops.restarted[0] != "" {
		t.Fatalf("restart all: %d %v", rec.Code, ops.restarted)
	}
	rec, _ = do(t, g, http.MethodPost, "/.boxlite/sv/restart", `{"service":"web"}`, ctl())
	if rec.Code != http.StatusOK || ops.restarted[1] != "web" {
		t.Fatalf("restart web: %d %v", rec.Code, ops.restarted)
	}
	ops.restartErr = api.ErrNoService
	rec, body = do(t, g, http.MethodPost, "/.boxlite/sv/restart", `{"service":"nope"}`, ctl())
	if rec.Code != http.StatusNotFound || body["error"] != "not_found_service" {
		t.Fatalf("restart unknown: %d %s", rec.Code, rec.Body.String())
	}

	rec, body = do(t, g, http.MethodGet, "/.boxlite/sv/logs?source=web&tail=5", "", ctl())
	lines, _ := body["lines"].([]any)
	if rec.Code != http.StatusOK || len(lines) != 1 || lines[0].(map[string]any)["line"] != "tail=5" {
		t.Fatalf("logs: %d %s", rec.Code, rec.Body.String())
	}
	rec, _ = do(t, g, http.MethodGet, "/.boxlite/sv/logs?tail=x", "", ctl())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad tail: %d", rec.Code)
	}
	rec, _ = do(t, g, http.MethodGet, "/.boxlite/sv/unknown", "", ctl())
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown control path: %d", rec.Code)
	}
}

// F3: the forward secret (end-user traffic) never opens the control API, the
// control secret never reaches the app, and no spelling of /.boxlite/sv/ gets
// to control() with the forward secret attached.
func TestForwardSecretNeverReachesControl(t *testing.T) {
	var hits []string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		io.WriteString(w, "app")
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	port, _ := strconv.Atoi(u.Port())
	ops := &fakeOps{}
	g := New(ops, true)
	g.SetSecrets(secret, ctlSecret)
	g.SetTarget(port, "")

	paths := []string{
		"/.boxlite/sv/deploy", "/.boxlite/sv/health", "/.boxlite/sv/files?path=/data",
		"/.BOXLITE/sv/deploy", "/.boxlite/SV/deploy", "//.boxlite/sv/deploy", "/./.boxlite/sv/deploy",
		"/x/../.boxlite/sv/deploy", "/%2eboxlite/sv/deploy", "/.boxlite%2fsv/deploy", "/.boxlite/sv",
		"/.boxlite/sv/", "/.boxlite/sv/deploy/", "/.boxlite//sv/deploy",
	}
	for _, p := range paths {
		for _, hdr := range []map[string]string{
			auth(), // what an end-user request carries
			{SecretHeader: secret, ControlHeader: ctlSecret}, // both: still refused
		} {
			rec, body := do(t, g, http.MethodPost, p, `{"deployment":1}`, hdr)
			if rec.Code != http.StatusForbidden || body["error"] != "gateway" {
				t.Fatalf("%s with %v: %d %s, want 403", p, hdr, rec.Code, rec.Body.String())
			}
		}
	}
	if len(ops.deployed) != 0 || len(hits) != 0 {
		t.Fatalf("forward-secret requests reached control %v or the app %v", ops.deployed, hits)
	}

	// The control secret opens control only, and is not a key to the app.
	if rec, _ := do(t, g, http.MethodGet, "/.boxlite/sv/health", "", ctl()); rec.Code != http.StatusOK {
		t.Fatalf("control health: %d", rec.Code)
	}
	if rec, body := do(t, g, http.MethodGet, "/", "", ctl()); rec.Code != http.StatusForbidden || body["error"] != "gateway" {
		t.Fatalf("control secret on an app path: %d %s", rec.Code, rec.Body.String())
	}
	// A lenient spelling with the control secret is refused rather than guessed at.
	if rec, _ := do(t, g, http.MethodGet, "/.BOXLITE/sv/health", "", ctl()); rec.Code != http.StatusNotFound {
		t.Fatalf("uppercase control path with control secret: %d", rec.Code)
	}
	if len(hits) != 0 {
		t.Fatalf("control-secret requests reached the app: %v", hits)
	}
}

func TestControlSecretAndIdentityNeverReachTheApp(t *testing.T) {
	var seen http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	port, _ := strconv.Atoi(u.Port())

	// Trust on (every app Box): identity passes only with the forward secret.
	g := New(&fakeOps{}, true)
	g.SetSecrets(secret, ctlSecret)
	g.SetTarget(port, "")
	hdr := map[string]string{SecretHeader: secret, ControlHeader: ctlSecret, "X-BoxLite-User-Id": "u1", "X-BoxLite-Identity": "jwt"}
	if rec, _ := do(t, g, http.MethodGet, "/", "", hdr); rec.Code != http.StatusOK {
		t.Fatalf("proxy: %d", rec.Code)
	}
	if seen.Get(ControlHeader) != "" || seen.Get(SecretHeader) != "" {
		t.Fatalf("a secret reached the app: %v", seen)
	}
	if seen.Get("X-BoxLite-User-Id") != "u1" || seen.Get("X-BoxLite-Identity") != "jwt" {
		t.Fatalf("trusted identity should pass with the forward secret: %v", seen)
	}
	// Loopback without the forward secret (app code calling :8080 with forged
	// identity) is refused outright; it never reaches the service.
	seen = nil
	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.RemoteAddr = "127.0.0.1:5555"
	req.Header.Set("X-BoxLite-User-Id", "admin")
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || seen != nil {
		t.Fatalf("loopback request without the forward secret: %d, reached app: %v", rec.Code, seen != nil)
	}
}
