// Package cp is the supervisor's client for the control plane's /sv/v1/* API
// (contracts.md 2.2) plus the batched log shipper.
package cp

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
)

// Defaults for the snapshot download (H19 in docs/code-health.md): without
// them a control plane that stops sending mid-stream holds the deploy slot,
// and every later deploy gets 409, until the Box restarts.
const (
	// DefaultSnapshotStall is how long a snapshot download may go without
	// receiving a single byte (response headers included) before it is
	// abandoned. The overall deadline is the caller's context.
	DefaultSnapshotStall = 30 * time.Second
	// responseHeaderTimeout bounds the wait for response headers on every
	// call. None of the /sv/v1 endpoints streams before its headers.
	responseHeaderTimeout = 30 * time.Second
	// mountsTTL is how long VolumeMounts trusts its last answer; a volume
	// change replaces the Box anyway.
	mountsTTL = 15 * time.Second
)

// ErrSnapshotStalled means the snapshot download received nothing for the
// stall timeout.
var ErrSnapshotStalled = errors.New("snapshot download stalled")

// Client talks to one control plane with the box token.
type Client struct {
	base  *url.URL
	token string
	http  *http.Client

	// SnapshotStall overrides DefaultSnapshotStall (tests).
	SnapshotStall time.Duration

	mountsMu sync.Mutex
	mountsAt time.Time
	mounts   []string
}

// New builds a client for baseURL. insecure skips TLS verification for local
// control planes with self-signed certificates; never set it in production.
func New(baseURL, token string, insecure bool) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("control plane url: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("control plane url %q must be absolute (http[s]://host)", baseURL)
	}
	if token == "" {
		return nil, errors.New("box token is empty")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = responseHeaderTimeout
	if insecure {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // opt-in for local tests
	}
	// No client-wide timeout: snapshot downloads can be large. Each call bounds
	// itself with a context instead, and the snapshot body with a stall timer.
	return &Client{base: u, token: token, http: &http.Client{Transport: tr}, SnapshotStall: DefaultSnapshotStall}, nil
}

// BaseURL returns the control plane origin.
func (c *Client) BaseURL() string { return c.base.String() }

func (c *Client) request(ctx context.Context, method, path string, body []byte) (*http.Request, error) {
	u := c.base.JoinPath(path)
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", "boxlite-supervisor")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// HTTPError is a non-2xx answer from the control plane. Callers use Status to
// tell "reachable but says no" (e.g. 404: no spec yet) from transport failures.
type HTTPError struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("%s %s: HTTP %d: %s", e.Method, e.Path, e.Status, e.Body)
}

func checkStatus(resp *http.Response) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return &HTTPError{Method: resp.Request.Method, Path: resp.Request.URL.Path, Status: resp.StatusCode, Body: strings.TrimSpace(string(snippet))}
}

// Spec fetches GET /sv/v1/spec.
func (c *Client) Spec(ctx context.Context) (*api.SpecResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := c.request(ctx, http.MethodGet, "/sv/v1/spec", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := checkStatus(resp); err != nil {
		return nil, err
	}
	var out api.SpecResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode spec: %w", err)
	}
	if out.Env == nil {
		out.Env = map[string]string{}
	}
	return &out, nil
}

// Snapshot opens the tar.gz stream of a source snapshot. The URL handed out in
// the spec response wins; without one the client falls back to
// GET /sv/v1/snapshots/{id}. The box token is attached only when the URL lives
// on the control plane origin, so a pre-signed third-party URL never sees it.
// The caller owns the returned body and must close it.
func (c *Client) Snapshot(ctx context.Context, snap api.Snapshot) (io.ReadCloser, error) {
	var target *url.URL
	switch {
	case snap.URL != "":
		u, err := url.Parse(snap.URL)
		if err != nil {
			return nil, fmt.Errorf("snapshot url: %w", err)
		}
		if !u.IsAbs() {
			u = c.base.ResolveReference(u)
		}
		target = u
	case snap.ID != "":
		target = c.base.JoinPath("/sv/v1/snapshots/", snap.ID)
	default:
		return nil, errors.New("spec response names no snapshot")
	}
	stall := c.SnapshotStall
	if stall <= 0 {
		stall = DefaultSnapshotStall
	}
	ctx, cancel := context.WithCancelCause(ctx)
	// The stall timer runs from the request on: a server that never answers,
	// or stops sending, cancels the request. Every chunk read re-arms it.
	timer := time.AfterFunc(stall, func() {
		cancel(fmt.Errorf("%w: no data for %s", ErrSnapshotStalled, stall))
	})
	fail := func(err error) (io.ReadCloser, error) {
		timer.Stop()
		if cause := context.Cause(ctx); errors.Is(cause, ErrSnapshotStalled) {
			err = cause
		}
		cancel(nil)
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return fail(err)
	}
	req.Header.Set("User-Agent", "boxlite-supervisor")
	if strings.EqualFold(target.Host, c.base.Host) && target.Scheme == c.base.Scheme {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fail(fmt.Errorf("download snapshot: %w", err))
	}
	if err := checkStatus(resp); err != nil {
		resp.Body.Close()
		return fail(err)
	}
	timer.Reset(stall)
	return &stallReader{body: resp.Body, ctx: ctx, cancel: cancel, timer: timer, stall: stall}, nil
}

// stallReader is a snapshot body whose request is cancelled when no byte
// arrives for stall. Close releases the timer and the request.
type stallReader struct {
	body   io.ReadCloser
	ctx    context.Context
	cancel context.CancelCauseFunc
	timer  *time.Timer
	stall  time.Duration
}

func (r *stallReader) Read(p []byte) (int, error) {
	n, err := r.body.Read(p)
	if n > 0 {
		r.timer.Reset(r.stall)
	}
	if err != nil && !errors.Is(err, io.EOF) {
		if cause := context.Cause(r.ctx); errors.Is(cause, ErrSnapshotStalled) {
			err = cause
		}
	}
	return n, err
}

func (r *stallReader) Close() error {
	r.timer.Stop()
	err := r.body.Close()
	r.cancel(nil)
	return err
}

// VolumeMounts returns the mount points of the environment's volumes from
// GET /sv/v1/spec (`spec.volumes[].mount`), the same document the deploy
// manager acts on. Answers are cached for mountsTTL. Before the first deploy
// the spec is null and the list is empty, so nothing is reachable.
func (c *Client) VolumeMounts(ctx context.Context) ([]string, error) {
	c.mountsMu.Lock()
	defer c.mountsMu.Unlock()
	if c.mounts != nil && time.Since(c.mountsAt) < mountsTTL {
		return c.mounts, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := c.Spec(ctx)
	if err != nil {
		return nil, fmt.Errorf("volume mounts from the control plane: %w", err)
	}
	mounts := []string{}
	for _, v := range resp.Spec.Volumes {
		if v.Mount != "" {
			mounts = append(mounts, v.Mount)
		}
	}
	c.mounts, c.mountsAt = mounts, time.Now()
	return mounts, nil
}

// PostLogs sends one batch to POST /sv/v1/logs.
func (c *Client) PostLogs(ctx context.Context, lines []api.LogLine) error {
	body, err := json.Marshal(lines)
	if err != nil {
		return err
	}
	return c.post(ctx, "/sv/v1/logs", body)
}

// PostStatus sends a deployment phase to POST /sv/v1/status.
func (c *Client) PostStatus(ctx context.Context, st api.Status) error {
	if st.Services == nil {
		st.Services = []api.ServiceStatus{}
	}
	body, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return c.post(ctx, "/sv/v1/status", body)
}

func (c *Client) post(ctx context.Context, path string, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := c.request(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// checkStatus reads the error body itself, so it must run before the
	// drain that lets the connection be reused.
	err = checkStatus(resp)
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return err
}
