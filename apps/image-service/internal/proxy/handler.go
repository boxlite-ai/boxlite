// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/boxlite-ai/image-service/internal/oci"
	"github.com/gin-gonic/gin"
)

// Realm names this proxy in the challenge it answers an unauthenticated caller
// with. The value is not a secret and not a URL; it is what a client shows a
// human when it asks which credential to use.
const Realm = "boxlite-registry-proxy"

// registryProxy serves the pull half of the distribution protocol on behalf of
// callers that do not hold the upstream's credentials.
type registryProxy struct {
	upstream  *oci.Client
	runners   *runnerAuthenticator
	allowlist upstreamAllowlist
	limits    *pullLimiter
	tokens    *tokenBroker
}

// handle serves every path under /v2/.
//
// The version check and the pulls share a route because gin's router refuses to
// hold /v2/ and /v2/*path at once — registering both panics on a catch-all
// conflict — so the one endpoint that is a fixed path is separated here.
func (p *registryProxy) handle(c *gin.Context) {
	if c.Param("path") == "/" {
		p.version(c)
		return
	}
	p.pull(c)
}

// version answers the endpoint a client uses to discover what this registry
// requires of it.
//
// An unauthenticated caller is answered with a Basic challenge, and that answer
// is load-bearing rather than decorative. A client reads this response to decide
// whether to send a credential at all: answered 200 with no challenge, it
// concludes none is wanted and sends none, and every pull after it is refused
// for a reason the operator cannot see from the configuration.
func (p *registryProxy) version(c *gin.Context) {
	if _, ok := p.authenticated(c); !ok {
		return
	}
	c.Header("Docker-Distribution-Api-Version", "registry/2.0")
	c.Status(http.StatusOK)
}

func (p *registryProxy) pull(c *gin.Context) {
	route, err := ParseRoute(c.Request.URL.Path)
	if err != nil {
		p.refuseRoute(c, err)
		return
	}
	runnerID, ok := p.authenticated(c)
	if !ok {
		return
	}
	if err := p.allowlist.permit(route.PublishedHost); err != nil {
		refuse(c, http.StatusForbidden, oci.CodeDenied, err.Error())
		return
	}
	if retryAfter, allowed := p.limits.allow(runnerID, route.Org); !allowed {
		c.Header("Retry-After", strconv.Itoa(int(retryAfter.Round(time.Second)/time.Second)+1))
		// Which meter tripped is this proxy's business, not the caller's: it
		// slows down either way, and naming the wrong one sends an operator
		// looking in the wrong place.
		refuse(c, http.StatusTooManyRequests, oci.CodeTooManyRequests, "too many pulls; slow down")
		return
	}

	response, err := p.forward(c.Request.Context(), route, c.Request.Method, c.Request.Header)
	if err != nil {
		p.refuseUpstream(c, route, err)
		return
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		// The upstream refused us, not the caller. Passing its status through
		// would tell the caller to re-authenticate to this proxy, which it has
		// already done successfully, and it would loop.
		refuse(c, http.StatusForbidden, oci.CodeDenied,
			"upstream "+route.PublishedHost+" refused the pull")
		return
	}
	relay(c, response)
}

// forward issues the pull upstream, answering an authentication challenge once
// if the upstream makes one.
//
// The token is tried first and the challenge is only read when the upstream
// objects, so a warm token costs no extra round trip and a cold one costs
// exactly the 401 that names the scope to ask for.
func (p *registryProxy) forward(
	ctx context.Context,
	route Route,
	method string,
	inbound http.Header,
) (*http.Response, error) {
	header := upstreamHeader(inbound)
	token, _ := p.tokens.cached(route.Org, route.Upstream)
	response, err := p.upstream.Pull(ctx, method, route.Upstream, route.Request, merge(header, bearer(token)))
	if err != nil || response.StatusCode != http.StatusUnauthorized {
		return response, err
	}

	challenge := response.Header.Get("Www-Authenticate")
	response.Body.Close()
	if challenge == "" {
		return nil, errors.New("upstream refused the pull and named no way to authenticate")
	}

	token, err = p.tokens.acquire(ctx, route.Org, route.Upstream, challenge)
	if err != nil {
		return nil, err
	}
	return p.upstream.Pull(ctx, method, route.Upstream, route.Request, merge(header, bearer(token)))
}

// relay copies the upstream answer to the caller.
//
// Untouched, and streamed. The digest a client verifies covers the manifest
// bytes as the upstream served them, so re-encoding here breaks every pull; and
// a blob is measured in gigabytes, so holding one to inspect it would put the
// whole image in this process's memory.
func relay(c *gin.Context, response *http.Response) {
	for name, values := range response.Header {
		if withheld(name) {
			continue
		}
		for _, value := range values {
			c.Writer.Header().Add(name, value)
		}
	}
	c.Status(response.StatusCode)

	if _, err := io.Copy(c.Writer, response.Body); err != nil {
		// The status and headers are already on the wire, so nothing can be
		// said to the caller; the truncated body is the signal. Recording it is
		// what separates "the client hung up" from "the upstream did".
		slog.WarnContext(c.Request.Context(), "Relay ended early", "error", err)
	}
}

// withheld names the response headers that must not be copied onward.
func withheld(name string) bool {
	switch http.CanonicalHeaderKey(name) {
	// Hop-by-hop: they describe this connection, not the answer.
	case "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
		"Te", "Trailer", "Transfer-Encoding", "Upgrade":
		return true
	// The upstream's own challenge. Relaying it would tell the caller to
	// authenticate to a registry it holds no credential for, which is the whole
	// reason this proxy exists.
	case "Www-Authenticate":
		return true
	default:
		return false
	}
}

// upstreamHeader is the part of the caller's request that belongs to the pull
// rather than to the caller.
//
// Accept decides which manifest media type comes back, so dropping it turns an
// image index into a "manifest unknown" for clients that asked for one. Range
// is what a resumed blob download is made of. The caller's own Authorization is
// deliberately absent: it authenticates to this proxy and means nothing
// upstream.
func upstreamHeader(inbound http.Header) http.Header {
	forwarded := http.Header{}
	for _, name := range []string{"Accept", "Accept-Encoding", "Range", "If-None-Match"} {
		for _, value := range inbound.Values(name) {
			forwarded.Add(name, value)
		}
	}
	return forwarded
}

func merge(base, extra http.Header) http.Header {
	if len(extra) == 0 {
		return base
	}
	merged := base.Clone()
	if merged == nil {
		merged = http.Header{}
	}
	for name, values := range extra {
		for _, value := range values {
			merged.Add(name, value)
		}
	}
	return merged
}

// authenticated resolves the caller to a runner, answering the caller itself
// when it cannot.
func (p *registryProxy) authenticated(c *gin.Context) (string, bool) {
	_, apiKey, presented := c.Request.BasicAuth()
	if !presented {
		challenge(c)
		return "", false
	}

	runnerID, err := p.runners.authenticate(c.Request.Context(), apiKey)
	switch {
	case errors.Is(err, ErrUnauthenticated):
		challenge(c)
		return "", false
	case errors.Is(err, ErrAuthUnavailable):
		// Not a refusal: the control plane could not be asked. Saying so beats
		// a bare 500, which reads as a bug in this proxy, and beats admitting
		// the caller, which would make the control plane's outage a way in.
		slog.WarnContext(c.Request.Context(), "Cannot verify a caller", "error", err)
		refuse(c, http.StatusServiceUnavailable, oci.CodeUnauthorized,
			"cannot verify credentials right now; retry shortly")
		return "", false
	case err != nil:
		refuse(c, http.StatusInternalServerError, oci.CodeUnauthorized, "credential check failed")
		return "", false
	}
	return runnerID, true
}

// challenge states what this proxy wants, which is Basic: a caller holds a
// runner API key, and there is no token endpoint here to trade it at.
func challenge(c *gin.Context) {
	c.Header("Www-Authenticate", `Basic realm="`+Realm+`"`)
	refuse(c, http.StatusUnauthorized, oci.CodeUnauthorized, "authentication required")
}

func (p *registryProxy) refuseRoute(c *gin.Context, err error) {
	switch {
	case errors.Is(err, oci.ErrNotPullPath):
		refuse(c, http.StatusNotFound, oci.CodeUnsupported, "not a pull endpoint")
	case errors.Is(err, ErrNotRoutable), errors.Is(err, oci.ErrInvalidName), errors.Is(err, oci.ErrInvalidHost):
		refuse(c, http.StatusBadRequest, oci.CodeNameInvalid, err.Error())
	default:
		refuse(c, http.StatusBadRequest, oci.CodeManifestInvalid, err.Error())
	}
}

func (p *registryProxy) refuseUpstream(c *gin.Context, route Route, err error) {
	slog.WarnContext(c.Request.Context(), "Upstream pull failed",
		"upstream", route.Upstream.Endpoint, "repository", route.Upstream.Repository, "error", err)
	if errors.Is(err, ErrAddressRefused) {
		refuse(c, http.StatusForbidden, oci.CodeDenied,
			"upstream "+route.PublishedHost+" sent the pull to an address this proxy will not reach")
		return
	}
	refuse(c, http.StatusBadGateway, oci.CodeUnsupported,
		"upstream "+route.PublishedHost+" could not be reached")
}

// refuse answers with the document shape the specification gives refusals, so a
// client can act on the code rather than parse prose.
func refuse(c *gin.Context, status int, code oci.ErrorCode, message string) {
	c.JSON(status, oci.Refusal(code, message))
}
