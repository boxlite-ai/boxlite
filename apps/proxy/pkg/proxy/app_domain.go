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
	"strings"
	"time"

	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/gin-gonic/gin"
)

// errAppDomainNotFound is an unknown, unbound or currently unreachable platform
// hostname. The API folds the tunnel, inbound and box-state checks into its
// answer, so this is the one refusal the proxy forwards as 404.
var errAppDomainNotFound = errors.New("domain not found")

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

type appDomainTarget struct {
	Type          string `json:"type"`
	BoxID         string `json:"boxId"`
	Port          uint16 `json:"port"`
	EnvironmentID string `json:"environmentId"`
}

// resolveAppDomain asks the API which resource a platform hostname routes to
// right now. Only a single label under the app domain is ever bound, so a
// deeper name is refused here without a round trip. Not cached: a name that
// was just released must not forward again.
func (p *Proxy) resolveAppDomain(ctx context.Context, hostname string) (appDomainTarget, error) {
	label := strings.TrimSuffix(hostname, "."+p.appDomain())
	if label == "" || strings.Contains(label, ".") {
		return appDomainTarget{}, errAppDomainNotFound
	}
	response, err := p.previewGet(ctx, "preview", "domains", hostname)
	if err != nil {
		return appDomainTarget{}, fmt.Errorf("resolve domain %s: %w", hostname, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
		var target appDomainTarget
		if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&target); err != nil {
			return appDomainTarget{}, fmt.Errorf("resolve domain %s: malformed answer: %w", hostname, err)
		}
		if target.Type == "app" && target.EnvironmentID != "" {
			return target, nil
		}
		if (target.Type != "" && target.Type != "box") || target.BoxID == "" || target.Port == 0 {
			return appDomainTarget{}, fmt.Errorf("resolve domain %s: incomplete answer", hostname)
		}
		return target, nil
	case http.StatusNotFound:
		return appDomainTarget{}, errAppDomainNotFound
	default:
		return appDomainTarget{}, fmt.Errorf("resolve domain %s: API returned %d", hostname, response.StatusCode)
	}
}

// App traffic stays behind the API's access and end-user identity checks. Its
// Authorization and cookies belong to the App; proxy identity uses another header.
func (p *Proxy) appGatewayTarget(ctx *gin.Context, environmentID, escapedPath string) (*common_proxy.RequestTarget, error) {
	base := p.apiclient.GetConfig().Servers[0].URL
	endpoint, err := url.Parse(strings.TrimRight(base, "/") + "/internal/apps/ingress/" + url.PathEscape(environmentID) + escapedPath)
	if err != nil {
		return nil, fmt.Errorf("App gateway endpoint: %w", err)
	}
	for key := range ctx.Request.Header {
		lower := strings.ToLower(key)
		if strings.HasPrefix(lower, "x-boxlite-user-") || lower == "x-boxlite-identity" || lower == "x-boxlite-gateway" || lower == "x-boxlite-control" || lower == "x-boxlite-proxy-token" {
			ctx.Request.Header.Del(key)
		}
	}
	return &common_proxy.RequestTarget{
		URL: endpoint, Host: ctx.Request.Host,
		Headers: map[string]string{
			"X-BoxLite-Proxy-Token": p.config.ProxyApiKey,
			"X-Forwarded-Host":      ctx.Request.Host,
			"X-Forwarded-Proto":     p.config.ProxyProtocol,
		},
	}, nil
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
