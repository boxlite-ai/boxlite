// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// errAppDomainNotFound is an unknown, unbound or currently unreachable named
// hostname. The API folds the tunnel, inbound and box-state checks into its
// answer, so this is the one refusal the proxy forwards as 404.
var errAppDomainNotFound = errors.New("domain not found")

var domainLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// Named hosts always use exact API lookup; an unknown name never falls back to
// interpreting its first label as a generated port/Box address.
func (p *Proxy) namedDomainHost(host string) (string, bool) {
	if hostname, ok := p.appDomainHost(host); ok {
		return hostname, true
	}
	if p.config == nil || !p.config.CustomDomainsEnabled {
		return "", false
	}
	hostname := bareHost(host)
	proxyHost := bareHost(p.config.ProxyDomain)
	if hostname == proxyHost || hostname == p.appDomain() || strings.HasSuffix(hostname, "."+proxyHost) || net.ParseIP(hostname) != nil || len(hostname) > 253 {
		return "", false
	}
	labels := strings.Split(hostname, ".")
	if len(labels) < 2 {
		return "", false
	}
	for _, label := range labels {
		if !domainLabel.MatchString(label) {
			return "", false
		}
	}
	return hostname, true
}

func (p *Proxy) generatedDomainHost(host string) bool {
	if p.config == nil || p.config.ProxyDomain == "" {
		return false
	}
	hostname, suffix := bareHost(host), "."+bareHost(p.config.ProxyDomain)
	if !strings.HasSuffix(hostname, suffix) {
		return false
	}
	label := strings.TrimSuffix(hostname, suffix)
	return label != "" && !strings.Contains(label, ".")
}

// appDomain is the configured platform domain without any port: like
// PROXY_DOMAIN, a local stack may configure `app.localhost:4000`, and the port
// is the URL's, not the hostname's.
func (p *Proxy) appDomain() string {
	if p.config == nil {
		return ""
	}
	return bareHost(p.config.ProxyAppDomain)
}

// bareHost lowercases a host and drops a trailing dot and any port.
func bareHost(host string) string {
	if bare, _, err := net.SplitHostPort(host); err == nil {
		host = bare
	}
	return strings.ToLower(strings.TrimSuffix(host, "."))
}

// appDomainHost reports whether the request Host names a platform subdomain
// and returns it lowercased, without a port. The app domain itself is not a
// box hostname and is left to whatever else serves it. The check runs before
// the legacy `<port>-<box>` parse, which cannot tell `3000-abc.<app domain>`
// from its own encoding.
func (p *Proxy) appDomainHost(host string) (string, bool) {
	appDomain := p.appDomain()
	if appDomain == "" {
		return "", false
	}
	hostname := bareHost(host)
	if !strings.HasSuffix(hostname, "."+appDomain) {
		return "", false
	}
	return hostname, true
}

// resolveAppDomain asks the API which box port a named hostname routes to now.
// Platform names allow one label under the app domain; customer names can be
// deeper. Not cached: a released name must not forward again.
func (p *Proxy) resolveAppDomain(ctx context.Context, hostname string) (string, uint16, error) {
	if _, platform := p.appDomainHost(hostname); platform {
		label := strings.TrimSuffix(hostname, "."+p.appDomain())
		if label == "" || strings.Contains(label, ".") {
			return "", 0, errAppDomainNotFound
		}
	}
	response, err := p.previewGet(ctx, "preview", "domains", hostname)
	if err != nil {
		return "", 0, fmt.Errorf("resolve domain %s: %w", hostname, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
		var target struct {
			BoxID string `json:"boxId"`
			Port  uint16 `json:"port"`
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&target); err != nil {
			return "", 0, fmt.Errorf("resolve domain %s: malformed answer: %w", hostname, err)
		}
		if target.BoxID == "" || target.Port == 0 {
			return "", 0, fmt.Errorf("resolve domain %s: incomplete answer", hostname)
		}
		return target.BoxID, target.Port, nil
	case http.StatusNotFound:
		return "", 0, errAppDomainNotFound
	default:
		return "", 0, fmt.Errorf("resolve domain %s: API returned %d", hostname, response.StatusCode)
	}
}

// previewGet issues one authenticated GET to the API's preview routes, which
// the generated client does not expose. The caller closes the body.
func (p *Proxy) previewGet(ctx context.Context, segments ...string) (*http.Response, error) {
	configuration := p.apiclient.GetConfig()
	endpoint, err := url.JoinPath(configuration.Servers[0].URL, segments...)
	if err != nil {
		return nil, fmt.Errorf("build preview endpoint: %w", err)
	}
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	request, err := http.NewRequestWithContext(checkCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("build preview request: %w", err)
	}
	request.Header.Set("Authorization", configuration.DefaultHeader["Authorization"])
	client := configuration.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		cancel()
		return nil, err
	}
	response.Body = &bodyWithCancel{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

// bodyWithCancel ends the request's timeout context when the body is closed,
// so the response can outlive the helper that made it.
type bodyWithCancel struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *bodyWithCancel) Close() error {
	defer b.cancel()
	return b.ReadCloser.Close()
}
