// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boxlite-ai/image-service/internal/oci"
	"github.com/gin-gonic/gin"
)

// stubUpstream is one registry and its token endpoint, standing in for ghcr or
// Docker Hub. It records what it was asked so a test can assert on the request
// that crossed the wire rather than on the one the proxy meant to send.
type stubUpstream struct {
	server *httptest.Server

	manifest     []byte
	manifestType string
	blob         []byte
	// blobBarrier, when set, holds the blob response open after its first chunk
	// so a test can observe whether bytes reach the caller before the upstream
	// has finished sending.
	blobBarrier chan struct{}
	// requireToken makes the registry answer an unauthenticated pull with a
	// Bearer challenge, which is how ghcr and Docker Hub behave.
	requireToken bool
	issuedToken  string
	redirectBlob string

	mutex    sync.Mutex
	requests []stubRequest
	tokens   int
}

// blobFirstChunk is how much of a blob the stub sends before it waits.
const blobFirstChunk = 64 << 10

type stubRequest struct {
	method         string
	path           string
	host           string
	authorization  string
	accept         []string
	acceptEncoding string
}

func newStubUpstream(t *testing.T) *stubUpstream {
	t.Helper()
	upstream := &stubUpstream{
		manifest:     []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","layers":[]}`),
		manifestType: "application/vnd.oci.image.manifest.v1+json",
		blob:         []byte("compressed layer bytes"),
		issuedToken:  "upstream-issued-token",
	}
	upstream.server = httptest.NewTLSServer(http.HandlerFunc(upstream.serve))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func (u *stubUpstream) serve(w http.ResponseWriter, r *http.Request) {
	u.mutex.Lock()
	u.requests = append(u.requests, stubRequest{
		method:         r.Method,
		path:           r.URL.EscapedPath(),
		host:           r.Host,
		authorization:  r.Header.Get("Authorization"),
		accept:         r.Header.Values("Accept"),
		acceptEncoding: r.Header.Get("Accept-Encoding"),
	})
	u.mutex.Unlock()

	if r.URL.Path == "/token" {
		u.mutex.Lock()
		u.tokens++
		u.mutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"token":"`+u.issuedToken+`","expires_in":300}`)
		return
	}

	if u.requireToken && r.Header.Get("Authorization") != "Bearer "+u.issuedToken {
		w.Header().Set("Www-Authenticate",
			`Bearer realm="https://`+r.Host+`/token",service="`+r.Host+`"`)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"errors":[{"code":"UNAUTHORIZED"}]}`)
		return
	}

	switch {
	case strings.Contains(r.URL.Path, "/manifests/"):
		w.Header().Set("Content-Type", u.manifestType)
		w.Header().Set("Docker-Content-Digest", digestOf(u.manifest))
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(u.manifest)
		}
	case strings.Contains(r.URL.Path, "/blobs/"):
		if u.redirectBlob != "" {
			http.Redirect(w, r, u.redirectBlob, http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		if u.blobBarrier == nil {
			_, _ = w.Write(u.blob)
			return
		}
		// A first chunk, then wait: whether the caller already has these bytes
		// is the difference between streaming and buffering. The chunk is sized
		// past net/http's own 4 KiB response buffer, which every real layer
		// clears in its first read and which is not this proxy's to flush.
		_, _ = w.Write(u.blob[:blobFirstChunk])
		w.(http.Flusher).Flush()
		<-u.blobBarrier
		_, _ = w.Write(u.blob[blobFirstChunk:])
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (u *stubUpstream) seen() []stubRequest {
	u.mutex.Lock()
	defer u.mutex.Unlock()
	return append([]stubRequest(nil), u.requests...)
}

func (u *stubUpstream) tokensIssued() int {
	u.mutex.Lock()
	defer u.mutex.Unlock()
	return u.tokens
}

// pulls returns the requests that were pulls rather than token exchanges.
func (u *stubUpstream) pulls() []stubRequest {
	var pulls []stubRequest
	for _, request := range u.seen() {
		if request.path != "/token" {
			pulls = append(pulls, request)
		}
	}
	return pulls
}

// client dials this stub whatever host a URL names, so a test can drive a pull
// addressed to ghcr.io without ghcr.io being involved. The certificate is the
// stub's own, verified under the name it was issued for.
func (u *stubUpstream) client() *http.Client {
	return u.clientDialing(func(context.Context, string, string) (bool, error) { return true, nil })
}

// clientJudgingRedirects stands in for the registry on the first connection and
// puts every address after it through the production rule, which is what a
// redirect target is: an address the registry chose, not one this proxy built.
func (u *stubUpstream) clientJudgingRedirects(registryHost string) *http.Client {
	return u.clientDialing(func(_ context.Context, _, address string) (bool, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return false, err
		}
		if host == registryHost {
			return true, nil
		}
		ip := net.ParseIP(host)
		if ip == nil || !routable(ip) {
			return false, ErrAddressRefused
		}
		return false, errors.New("this test expects no reachable address beyond the stub")
	})
}

// clientDialing sends every connection the decision function admits to the
// stub, and reports the rest as refused.
func (u *stubUpstream) clientDialing(toStub func(context.Context, string, string) (bool, error)) *http.Client {
	pool := x509.NewCertPool()
	pool.AddCert(u.server.Certificate())
	address := u.server.Listener.Addr().String()

	// The production client with only its dialer replaced, so every other
	// transport setting under test is the one that ships.
	client := upstreamClient(func(ctx context.Context, network, requested string) (net.Conn, error) {
		stub, err := toStub(ctx, network, requested)
		if err != nil {
			return nil, err
		}
		if !stub {
			return nil, ErrAddressRefused
		}
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, address)
	}, 5*time.Second)
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{
		RootCAs: pool, ServerName: "example.com", MinVersion: tls.VersionTLS12,
	}
	return client
}

// testProxy is the registry proxy wired to stubs, mounted the way NewRouter
// mounts it. The proxy is returned alongside the router so a test can tighten
// one of its limits without rebuilding the rest.
func testProxy(t *testing.T, upstream *stubUpstream, plane *stubControlPlane, hosts ...string) (*gin.Engine, *registryProxy) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	client := oci.NewClient(upstream.client())
	proxy := &registryProxy{
		upstream:  client,
		runners:   newRunnerAuthenticator(plane.client(), time.Minute, time.Minute),
		allowlist: newUpstreamAllowlist(hosts),
		limits:    newPullLimiter(1000, 1000, 64),
		tokens:    newTokenBroker(client),
	}

	router := gin.New()
	router.GET(oci.PathPrefix+"*path", proxy.handle)
	router.HEAD(oci.PathPrefix+"*path", proxy.handle)
	return router, proxy
}

// pull drives one request through the proxy, presenting a runner's credential
// the way a puller does.
func pull(router *gin.Engine, method, path, apiKey string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	if apiKey != "" {
		request.SetBasicAuth("runner", apiKey)
	}
	request.Header.Set("Accept", "application/vnd.oci.image.manifest.v1+json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func digestOf(payload []byte) string {
	sum := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(sum[:])
}
