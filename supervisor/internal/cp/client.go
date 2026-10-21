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
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
)

// Client talks to one control plane with the box token.
type Client struct {
	base  *url.URL
	token string
	http  *http.Client
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
	if insecure {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // opt-in for local tests
	}
	// No client-wide timeout: snapshot downloads can be large. Each call bounds
	// itself with a context instead.
	return &Client{base: u, token: token, http: &http.Client{Transport: tr}}, nil
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "boxlite-supervisor")
	if strings.EqualFold(target.Host, c.base.Host) && target.Scheme == c.base.Scheme {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if err := checkStatus(resp); err != nil {
		resp.Body.Close()
		return nil, err
	}
	return resp.Body, nil
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
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return checkStatus(resp)
}
