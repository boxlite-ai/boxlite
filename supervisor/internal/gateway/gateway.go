// Package gateway is the HTTP front door of the Box (contracts.md 2.3). Two
// credentials, two jobs:
//
//   - the forward secret (header X-BoxLite-Gateway) rides on every end-user
//     request the control plane proxies. It only ever reaches the app: a
//     request carrying it to /.boxlite/sv/* is refused.
//   - the control secret (header X-BoxLite-Control) rides only on the control
//     plane's own calls to /.boxlite/sv/*. It never reaches the app.
//
// The app cannot read either: both live in the root-only state dir and the
// supervisor's environment, and app code runs as another uid (contracts.md 2.1).
package gateway

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
)

// SecretHeader carries the forward secret on proxied end-user traffic.
const SecretHeader = "X-BoxLite-Gateway"

// ControlHeader carries the control secret on /.boxlite/sv/* calls.
const ControlHeader = "X-BoxLite-Control"

const controlPrefix = "/.boxlite/sv/"

// Ops is what the control endpoints need from the deploy manager.
type Ops interface {
	Health() api.HealthResponse
	Deploy(deployment int) error
	Activate(deployment int) error
	Rollback(deployment int) error
	Restart(service string) error
	Logs(source string, tail int) []api.LogLine
}

// Target is where end-user traffic goes: a loopback port or a static directory.
// Both empty means nothing is live yet.
type Target struct {
	Port      int
	StaticDir string
}

// StaticOpener opens a static service's directory as an os.Root, so that every
// file the (root) gateway serves stays inside it even while app code swaps
// symlinks underneath. The default is os.OpenRoot; the supervisor installs one
// that is itself confined to the app directory.
type StaticOpener func(dir string) (*os.Root, error)

type secrets struct{ forward, control string }

// Server is the gateway handler.
type Server struct {
	ops     Ops
	secrets atomic.Pointer[secrets]
	target  atomic.Pointer[Target]
	static  atomic.Pointer[StaticOpener]
	// trustIdentity lets X-BoxLite-User-* set by the control plane reach the app.
	// Such headers are only ever honoured on requests that carry the forward
	// secret; without trust they are stripped even then.
	trustIdentity bool
	proxy         *httputil.ReverseProxy
}

// New builds a gateway. SetSecrets and SetTarget are expected to follow.
func New(ops Ops, trustIdentity bool) *Server {
	g := &Server{ops: ops, trustIdentity: trustIdentity}
	g.target.Store(&Target{})
	g.secrets.Store(&secrets{})
	g.proxy = &httputil.ReverseProxy{
		Rewrite:      g.rewrite,
		ErrorHandler: g.proxyError,
		Transport: &http.Transport{
			// Loopback only; keep a small pool so port flips release old
			// connections quickly, and never time out response headers because
			// apps may stream (SSE, long polls).
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			MaxIdleConns:        32,
			IdleConnTimeout:     30 * time.Second,
			DisableCompression:  true,
			ForceAttemptHTTP2:   false,
			TLSHandshakeTimeout: 5 * time.Second,
		},
		FlushInterval: -1, // flush immediately so streaming responses pass through
	}
	return g
}

// SetSecrets installs the forward and control secrets. An empty secret keeps
// its door shut: until the control plane has handed one over, nothing can
// authenticate with it.
func (g *Server) SetSecrets(forward, control string) {
	g.secrets.Store(&secrets{forward: forward, control: control})
}

// SetStaticOpener replaces how static directories are opened.
func (g *Server) SetStaticOpener(fn StaticOpener) { g.static.Store(&fn) }

// SetMounts replaces how the files endpoint learns the declared volume mounts.
// The supervisor wires it to its control-plane client so the box token never
// has to stay in the process environment.
func SetMounts(fn func() ([]string, error)) { declaredMounts = fn }

// SetTarget switches end-user traffic to a new port or static directory.
// It is atomic: in-flight requests finish against the old target.
func (g *Server) SetTarget(port int, staticDir string) {
	g.target.Store(&Target{Port: port, StaticDir: staticDir})
}

// Target returns the current routing target.
func (g *Server) Target() Target { return *g.target.Load() }

// ServeHTTP implements http.Handler.
func (g *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The Box tunnel URL is public; the secrets are the only thing separating
	// the control plane from the open internet, so they are checked before
	// anything else. The control namespace is matched loosely (cleaned,
	// case-insensitive) for refusals and strictly for dispatch, so no spelling
	// of /.boxlite/sv/ ever reaches control() or the app with the forward secret.
	s := g.secrets.Load()
	if inControlNamespace(r.URL.Path) {
		switch {
		case r.Header.Get(SecretHeader) != "":
			// End-user traffic never belongs here, whatever else it carries.
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "gateway"})
		case !matches(r.Header.Get(ControlHeader), s.control):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "gateway"})
		case !strings.HasPrefix(r.URL.Path, controlPrefix):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
		default:
			g.control(w, r)
		}
		return
	}
	if !matches(r.Header.Get(SecretHeader), s.forward) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "gateway"})
		return
	}
	t := g.target.Load()
	switch {
	case t.StaticDir != "":
		g.serveStatic(w, r, t.StaticDir)
	case t.Port > 0:
		g.proxy.ServeHTTP(w, r)
	default:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no_release"})
	}
}

// inControlNamespace reports whether p is any spelling of /.boxlite/sv or a
// path below it: Go has already percent-decoded p, and Clean folds `//`, `.`
// and `..` the way a lenient router would.
func inControlNamespace(p string) bool {
	c := strings.ToLower(path.Clean("/" + p))
	return c == "/.boxlite/sv" || strings.HasPrefix(c, "/.boxlite/sv/")
}

func matches(got, want string) bool {
	if want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// rewrite prepares the outbound request for the exposed service.
func (g *Server) rewrite(pr *httputil.ProxyRequest) {
	t := g.target.Load()
	pr.SetURL(&url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(t.Port))})
	// SetURL rewrote Host to 127.0.0.1:port; the app should see the public host.
	pr.Out.Host = pr.In.Host

	// ReverseProxy strips Forwarded/X-Forwarded-* before calling Rewrite. The
	// control plane set them from the end user's request, so copy them back and
	// append our own hop to X-Forwarded-For.
	for _, h := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
		if v := pr.In.Header.Values(h); len(v) > 0 {
			pr.Out.Header[h] = append([]string(nil), v...)
		}
	}
	if ip, _, err := net.SplitHostPort(pr.In.RemoteAddr); err == nil {
		if prior := pr.Out.Header.Get("X-Forwarded-For"); prior != "" {
			ip = prior + ", " + ip
		}
		pr.Out.Header.Set("X-Forwarded-For", ip)
	}

	// Never leak either secret into application code or its logs.
	pr.Out.Header.Del(SecretHeader)
	pr.Out.Header.Del(ControlHeader)

	// Only requests that proved they come from the control plane (forward
	// secret, checked in ServeHTTP) get here, so with trust on the CP's
	// identity headers pass; without it they are forged and dropped.
	if !g.trustIdentity {
		for k := range pr.Out.Header {
			lk := strings.ToLower(k)
			if strings.HasPrefix(lk, "x-boxlite-user-") || lk == "x-boxlite-identity" {
				delete(pr.Out.Header, k)
			}
		}
	}
}

func (g *Server) proxyError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) {
		return // client went away
	}
	// A refused connection means the exposed service is (re)starting: right
	// after a Box wake the app may not have bound PORT yet, or it is in a
	// crash backoff. 503 + Retry-After lets the control plane show its
	// "Starting…" page instead of an error (contracts.md section 3).
	if errors.Is(err, syscall.ECONNREFUSED) {
		w.Header().Set("Retry-After", "3")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "service_unavailable", "message": "the service is not accepting connections yet"})
		return
	}
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "bad_gateway", "message": err.Error()})
}

// control serves /.boxlite/sv/*.
func (g *Server) control(w http.ResponseWriter, r *http.Request) {
	switch strings.TrimPrefix(r.URL.Path, controlPrefix) {
	case "health":
		if !allow(w, r, http.MethodGet) {
			return
		}
		writeJSON(w, http.StatusOK, g.ops.Health())
	case "deploy":
		g.deploymentCall(w, r, g.ops.Deploy)
	case "activate":
		g.deploymentCall(w, r, g.ops.Activate)
	case "rollback":
		g.deploymentCall(w, r, g.ops.Rollback)
	case "restart":
		if !allow(w, r, http.MethodPost) {
			return
		}
		var body struct {
			Service *string `json:"service"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": err.Error()})
			return
		}
		name := ""
		if body.Service != nil {
			name = *body.Service
		}
		switch err := g.ops.Restart(name); {
		case errors.Is(err, api.ErrNoService):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found_service"})
		case errors.Is(err, api.ErrNoRelease):
			writeJSON(w, http.StatusConflict, map[string]string{"error": "no_release"})
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal", "message": err.Error()})
		default:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		}
	case "files":
		g.files(w, r)
	case "logs":
		if !allow(w, r, http.MethodGet) {
			return
		}
		tail := 200
		if v := r.URL.Query().Get("tail"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "tail must be a non-negative integer"})
				return
			}
			tail = min(n, logs.RingSize)
		}
		writeJSON(w, http.StatusOK, map[string]any{"lines": g.ops.Logs(r.URL.Query().Get("source"), tail)})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
	}
}

// deploymentCall handles the three {"deployment":N} → 202 endpoints.
func (g *Server) deploymentCall(w http.ResponseWriter, r *http.Request, fn func(int) error) {
	if !allow(w, r, http.MethodPost) {
		return
	}
	var body struct {
		Deployment int `json:"deployment"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": err.Error()})
		return
	}
	if body.Deployment <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "deployment must be a positive integer"})
		return
	}
	switch err := fn(body.Deployment); {
	case errors.Is(err, api.ErrBusy):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "deploy_in_progress"})
	case errors.Is(err, api.ErrNotBuilt):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not_built"})
	case errors.Is(err, api.ErrNoRelease):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found_release"})
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal", "message": err.Error()})
	default:
		writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true, "deployment": body.Deployment})
	}
}

func allow(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
	return false
}

func decodeBody(r *http.Request, v any) error {
	data, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil // an empty body means defaults (e.g. restart all)
	}
	return json.Unmarshal(data, v)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
