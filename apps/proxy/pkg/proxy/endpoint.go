// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var endpointNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,46}[a-z0-9]$`)

type endpointContextKey struct{}

type boxEndpoint struct {
	BoxID string `json:"boxId"`
	Port  int    `json:"port"`
	URL   string `json:"url"`
}

// Resolve once per request, before either the HTTP router or CONNECT handler.
// Deliberately do not cache: revocation and rebinding apply to the next request.
func (p *Proxy) withBoxEndpoint(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		label, _, _ := strings.Cut(strings.ToLower(r.Host), ".")
		name, isEndpoint := strings.CutPrefix(label, "app-")
		if !isEndpoint {
			next.ServeHTTP(w, r)
			return
		}
		if !endpointNamePattern.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		endpoint, status := p.resolveBoxEndpoint(r.Context(), name, r.Host)
		if status != http.StatusOK {
			http.Error(w, http.StatusText(status), status)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), endpointContextKey{}, endpoint))
		next.ServeHTTP(w, r)
	})
}

func (p *Proxy) resolveBoxEndpoint(ctx context.Context, name, host string) (*boxEndpoint, int) {
	if p.config == nil {
		return nil, http.StatusBadGateway
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(p.config.BoxliteApiUrl, "/")+"/box-endpoints/resolve/"+url.PathEscape(name), nil)
	if err != nil {
		return nil, http.StatusBadGateway
	}
	request.Header.Set("Authorization", "Bearer "+p.config.ProxyApiKey)
	client := &http.Client{Timeout: 5 * time.Second}
	if p.apiclient != nil && p.apiclient.GetConfig().HTTPClient != nil {
		client.Transport = p.apiclient.GetConfig().HTTPClient.Transport
	}
	// A redirect must never send the proxy's service credential to another URL.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return nil, http.StatusBadGateway
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, http.StatusNotFound
	}
	if response.StatusCode != http.StatusOK {
		return nil, http.StatusBadGateway
	}
	var endpoint boxEndpoint
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&endpoint); err != nil ||
		!isValidDirectPreviewBoxID(endpoint.BoxID) || endpoint.Port < 1 || endpoint.Port > 65535 || endpoint.Port == 22222 {
		return nil, http.StatusBadGateway
	}
	assigned, err := url.Parse(endpoint.URL)
	if err != nil || (assigned.Scheme != "https" && assigned.Scheme != "http") || assigned.Host == "" ||
		assigned.User != nil || assigned.RawQuery != "" || assigned.Fragment != "" || (assigned.Path != "" && assigned.Path != "/") {
		return nil, http.StatusBadGateway
	}
	if canonicalEndpointHost(host, assigned.Scheme) != canonicalEndpointHost(assigned.Host, assigned.Scheme) {
		return nil, http.StatusNotFound
	}
	return &endpoint, http.StatusOK
}

func canonicalEndpointHost(host, scheme string) string {
	host = strings.ToLower(host)
	if hostname, port, err := net.SplitHostPort(host); err == nil {
		hostname = strings.TrimSuffix(hostname, ".")
		if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
			return hostname
		}
		return net.JoinHostPort(hostname, port)
	}
	return strings.TrimSuffix(host, ".")
}

func (p *Proxy) parseRequestHost(request *http.Request) (string, string, string, error) {
	if endpoint, ok := request.Context().Value(endpointContextKey{}).(*boxEndpoint); ok {
		_, baseHost, found := strings.Cut(request.Host, ".")
		if !found {
			return "", "", "", errors.New("endpoint host requires a domain")
		}
		return strconv.Itoa(endpoint.Port), "d-" + hex.EncodeToString([]byte(endpoint.BoxID)), baseHost, nil
	}
	if strings.HasPrefix(strings.ToLower(request.Host), "app-") {
		return "", "", "", fmt.Errorf("endpoint host has not been resolved")
	}
	return p.parseHost(request.Host)
}
