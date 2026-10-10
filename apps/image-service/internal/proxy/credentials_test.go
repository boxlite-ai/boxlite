// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/image-service/internal/oci"
	"github.com/gin-gonic/gin"
)

const (
	acmeVersion  = "registry-credential-acme"
	acmePassword = "ghp_not-a-real-token"
	// acmeOrg is an organization id, as the control plane issues them. Paths
	// under any other shape of org name no organization and stay anonymous.
	acmeOrg     = "0aaa0000-0000-4000-8000-000000000001"
	privatePath = "/v2/" + acmeOrg + "/ghcr.io/acme/app/manifests/1.2"
	// strangerKey belongs to a runner that hosts no box of acme's: one of
	// another organization's own runners, say.
	strangerKey = "stranger-runner-key"
)

// passwords stands in for the secret store: version to password.
type passwords map[string]string

func (p passwords) Read(_ context.Context, version string) (string, error) {
	password, held := p[version]
	if !held {
		return "", errors.New("no such version")
	}
	return password, nil
}

// clock is a time a test moves by hand.
type clock struct{ at time.Time }

func (c *clock) now() time.Time { return c.at }

// privateProxy is a proxy whose control plane has registered acme's login for
// privatePath's repository, with the password in a store it can read. The
// runner behind runnerKey hosts a box of acme's; the one behind strangerKey
// does not.
func privateProxy(t *testing.T, upstream *stubUpstream) (*gin.Engine, *registryProxy, *stubControlPlane, *clock) {
	t.Helper()
	upstream.requireToken = true
	plane := newStubControlPlane(t, map[string]string{runnerKey: "runner-7", strangerKey: "runner-9"})
	plane.logins.Store(acmeOrg+" ghcr.io acme/app", acmeVersion)
	plane.hosting.Store(runnerKey+" "+acmeOrg, true)

	router, proxy := testProxy(t, upstream, plane, "ghcr.io")
	proxy.credentials = newCredentialFinder(plane.client(), passwords{acmeVersion: acmePassword}, time.Minute)
	moment := &clock{at: time.Now()}
	proxy.tokens.tokens.now = moment.now
	return router, proxy, plane, moment
}

// tokenRequests are the exchanges the upstream saw, in order.
func tokenRequests(upstream *stubUpstream) []stubRequest {
	var exchanges []stubRequest
	for _, request := range upstream.seen() {
		if request.path == "/token" {
			exchanges = append(exchanges, request)
		}
	}
	return exchanges
}

func TestAPrivatePullPresentsTheOrganizationsLoginToTheTokenEndpoint(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _, plane, _ := privateProxy(t, upstream)

	response := pull(router, http.MethodGet, privatePath, runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", privatePath, response.Code, response.Body.String())
	}

	exchanges := tokenRequests(upstream)
	if len(exchanges) != 1 {
		t.Fatalf("the token endpoint was asked %d times, want 1", len(exchanges))
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("acme-bot:"+acmePassword))
	if exchanges[0].authorization != want {
		t.Errorf("the exchange carried %q, want acme's login", exchanges[0].authorization)
	}
	// The control plane answers runners only, and the proxy has no key of its
	// own: the lookup is made with the key the runner presented.
	if got := plane.lookupKey.Load(); got != runnerKey {
		t.Errorf("the lookup was made with %v, want the runner's key", got)
	}
	// The login travels to the token endpoint and nowhere else.
	for _, request := range upstream.pulls() {
		if strings.HasPrefix(request.authorization, "Basic ") {
			t.Errorf("a pull of %s carried the login itself", request.path)
		}
	}
}

func TestATokenBoughtWithALoginIsKeptFiveMinutesAtMost(t *testing.T) {
	upstream := newStubUpstream(t)
	// gcr.io's, measured: twelve hours. Kept that long, a deleted login would
	// go on pulling for half a day.
	upstream.tokenExpiresIn = 43200
	router, _, _, moment := privateProxy(t, upstream)

	pull(router, http.MethodGet, privatePath, runnerKey)
	moment.at = moment.at.Add(credentialedTokenLifetime - time.Second)
	pull(router, http.MethodGet, privatePath, runnerKey)
	if exchanges := len(tokenRequests(upstream)); exchanges != 1 {
		t.Fatalf("within five minutes the token endpoint was asked %d times, want 1", exchanges)
	}

	moment.at = moment.at.Add(2 * time.Second)
	if response := pull(router, http.MethodGet, privatePath, runnerKey); response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", privatePath, response.Code, response.Body.String())
	}
	if exchanges := len(tokenRequests(upstream)); exchanges != 2 {
		t.Errorf("past five minutes the token endpoint was asked %d times in all, want a second exchange", exchanges)
	}
}

func TestATokenStatedShorterThanTheCapKeepsItsOwnLifetime(t *testing.T) {
	upstream := newStubUpstream(t)
	upstream.tokenExpiresIn = 60
	router, _, _, moment := privateProxy(t, upstream)

	pull(router, http.MethodGet, privatePath, runnerKey)
	moment.at = moment.at.Add(61 * time.Second)
	pull(router, http.MethodGet, privatePath, runnerKey)

	if exchanges := len(tokenRequests(upstream)); exchanges != 2 {
		t.Errorf("a 60s token was exchanged %d times across 61s, want 2", exchanges)
	}
}

func TestAnAnonymousTokenIsNotCapped(t *testing.T) {
	upstream := newStubUpstream(t)
	upstream.tokenExpiresIn = 43200
	router, proxy, _, moment := privateProxy(t, upstream)
	proxy.credentials = nil

	pull(router, http.MethodGet, privatePath, runnerKey)
	moment.at = moment.at.Add(credentialedTokenLifetime + time.Minute)
	pull(router, http.MethodGet, privatePath, runnerKey)

	if exchanges := len(tokenRequests(upstream)); exchanges != 1 {
		t.Errorf("an anonymous token was exchanged %d times, want it kept for its stated lifetime", exchanges)
	}
}

func TestARepositoryWithoutALoginIsPulledAnonymously(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _, plane, _ := privateProxy(t, upstream)
	const otherPath = "/v2/" + acmeOrg + "/ghcr.io/acme/public/manifests/1.2"

	for range 2 {
		if response := pull(router, http.MethodGet, otherPath, runnerKey); response.Code != http.StatusOK {
			t.Fatalf("GET %s = %d: %s", otherPath, response.Code, response.Body.String())
		}
	}

	if exchanges := tokenRequests(upstream); len(exchanges) != 1 || exchanges[0].authorization != "" {
		t.Errorf("the exchanges were %+v, want one with nothing presented", exchanges)
	}
	if lookups := plane.lookups.Load(); lookups != 1 {
		t.Errorf("the control plane was asked %d times, want the answer \"none\" cached too", lookups)
	}
}

func TestALoginThatCannotBeLookedUpFailsThePullRatherThanGoingAnonymous(t *testing.T) {
	upstream := newStubUpstream(t)
	router, proxy, plane, _ := privateProxy(t, upstream)
	// The runner is already verified, so only the lookup meets the outage.
	pull(router, http.MethodGet, "/v2/"+acmeOrg+"/ghcr.io/acme/app/blobs/sha256:"+strings.Repeat("a", 64), runnerKey)
	proxy.tokens = newTokenBroker(proxy.upstream)
	proxy.credentials = newCredentialFinder(plane.unreachable(), passwords{}, time.Minute)
	before := len(tokenRequests(upstream))

	response := pull(router, http.MethodGet, privatePath, runnerKey)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET %s = %d, want 503: %s", privatePath, response.Code, response.Body.String())
	}
	if after := len(tokenRequests(upstream)); after != before {
		t.Error("the pull went on to exchange anonymously, which would report a missing login as a denial")
	}
}

func TestALoginTheUpstreamRefusesIsReportedAsTheOrganizationsToFix(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _, _, _ := privateProxy(t, upstream)
	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Www-Authenticate", `Bearer realm="https://`+r.Host+`/token",service="`+r.Host+`"`)
		w.WriteHeader(http.StatusUnauthorized)
	})

	response := pull(router, http.MethodGet, privatePath, runnerKey)

	if response.Code != http.StatusForbidden {
		t.Fatalf("GET %s = %d, want 403: %s", privatePath, response.Code, response.Body.String())
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeDenied)
	if !strings.Contains(response.Body.String(), "refused the organization's registry credential") {
		t.Errorf("the refusal %s does not say the login was refused", response.Body.String())
	}
	if strings.Contains(response.Body.String(), acmePassword) {
		t.Error("the refusal carries the password")
	}
}

func TestWithoutASecretStoreTheControlPlaneIsNeverAskedForALogin(t *testing.T) {
	upstream := newStubUpstream(t)
	router, proxy, plane, _ := privateProxy(t, upstream)
	proxy.credentials = newCredentialFinder(plane.client(), nil, time.Minute)

	if response := pull(router, http.MethodGet, privatePath, runnerKey); response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", privatePath, response.Code, response.Body.String())
	}
	if lookups := plane.lookups.Load(); lookups != 0 {
		t.Errorf("the control plane was asked for a login %d times with no store to read it from", lookups)
	}
}

func TestALoginIsNotSentToATokenEndpointOnAnotherHost(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _, _, _ := privateProxy(t, upstream)
	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Nothing listens there; the point is that nothing tries.
		w.Header().Set("Www-Authenticate", `Bearer realm="https://token.elsewhere.invalid/token",service="x"`)
		w.WriteHeader(http.StatusUnauthorized)
	})

	response := pull(router, http.MethodGet, privatePath, runnerKey)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("GET %s = %d, want 502: %s", privatePath, response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "credential was not sent") {
		t.Errorf("the refusal %s does not say the login was withheld", response.Body.String())
	}
}

func TestDockerHubsTokenEndpointMayReceiveALogin(t *testing.T) {
	dockerHub := oci.Upstream{Endpoint: "registry-1.docker.io", Repository: "library/alpine"}
	challenge, _ := oci.ParseChallenge(`Bearer realm="https://auth.docker.io/token",service="registry.docker.io"`)
	if err := checkRealm(challenge, dockerHub); err != nil {
		t.Errorf("Docker Hub's own token endpoint was refused: %v", err)
	}

	ghcr := oci.Upstream{Endpoint: "ghcr.io", Repository: "acme/app"}
	if err := checkRealm(challenge, ghcr); !errors.Is(err, ErrRealmRefused) {
		t.Errorf("ghcr.io naming Docker Hub's token endpoint = %v, want ErrRealmRefused", err)
	}
}

func TestARunnerThatHostsNoBoxOfTheOrganizationIsRefusedItsLogin(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _, _, _ := privateProxy(t, upstream)

	response := pull(router, http.MethodGet, privatePath, strangerKey)

	if response.Code != http.StatusForbidden {
		t.Fatalf("GET %s as a stranger = %d, want 403: %s", privatePath, response.Code, response.Body.String())
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeDenied)
	if exchanges := tokenRequests(upstream); len(exchanges) != 0 {
		t.Errorf("the token endpoint was asked %d times; nothing should be exchanged for a refused runner", len(exchanges))
	}
}

func TestOneRunnersTokenIsNotAnothersToUse(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _, plane, _ := privateProxy(t, upstream)

	// acme's runner looks the login up and buys a token with it; both are now
	// warm, and the stranger's pull comes while they are.
	if response := pull(router, http.MethodGet, privatePath, runnerKey); response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", privatePath, response.Code, response.Body.String())
	}

	if response := pull(router, http.MethodGet, privatePath, strangerKey); response.Code != http.StatusForbidden {
		t.Fatalf("a stranger while acme's token is warm = %d, want 403: it was served acme's token", response.Code)
	}
	if got := plane.lookupKey.Load(); got != strangerKey {
		t.Errorf("the last lookup was made with %v; the stranger's pull never asked for itself", got)
	}
}

func TestARefusalIsRememberedLikeAnyOtherAnswer(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _, plane, _ := privateProxy(t, upstream)

	for range 3 {
		if response := pull(router, http.MethodGet, privatePath, strangerKey); response.Code != http.StatusForbidden {
			t.Fatalf("GET %s as a stranger = %d, want 403", privatePath, response.Code)
		}
	}
	if lookups := plane.lookups.Load(); lookups != 1 {
		t.Errorf("the control plane was asked %d times for one refused runner, want 1", lookups)
	}
}

func TestAPathThatNamesNoOrganizationIsPulledAnonymouslyWithoutALookup(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _, plane, _ := privateProxy(t, upstream)

	if response := pull(router, http.MethodGet, ghcrPath, runnerKey); response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}
	if lookups := plane.lookups.Load(); lookups != 0 {
		t.Errorf("the control plane was asked %d times about an organization that cannot exist", lookups)
	}
	if exchanges := tokenRequests(upstream); len(exchanges) != 1 || exchanges[0].authorization != "" {
		t.Errorf("the exchanges were %+v, want one anonymous one", exchanges)
	}
}

func TestAPasswordThatCannotBeReadFailsThePullAsUnavailable(t *testing.T) {
	upstream := newStubUpstream(t)
	router, proxy, plane, _ := privateProxy(t, upstream)
	proxy.credentials = newCredentialFinder(plane.client(), passwords{}, time.Minute)

	response := pull(router, http.MethodGet, privatePath, runnerKey)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET %s = %d, want 503: %s", privatePath, response.Code, response.Body.String())
	}
	if exchanges := tokenRequests(upstream); len(exchanges) != 0 {
		t.Error("the pull went on to exchange without the password")
	}
}

func TestARotatedLoginIsPresentedBeforeTheCachedAnswerExpires(t *testing.T) {
	upstream := newStubUpstream(t)
	router, proxy, plane, moment := privateProxy(t, upstream)
	pull(router, http.MethodGet, privatePath, runnerKey)

	// There is no update, so rotating a password is a delete and an add: the
	// old version is destroyed and the control plane names a new one, while
	// this proxy still holds the answer that named the old. The token the old
	// password bought has lapsed too, so the next pull exchanges again.
	const rotatedVersion, rotatedPassword = "registry-credential-acme-2", "ghp_rotated-not-a-real-token"
	plane.logins.Store(acmeOrg+" ghcr.io acme/app", rotatedVersion)
	proxy.credentials.secrets = passwords{rotatedVersion: rotatedPassword}
	moment.at = moment.at.Add(credentialedTokenLifetime + time.Second)

	response := pull(router, http.MethodGet, privatePath, runnerKey)

	if response.Code != http.StatusOK {
		t.Fatalf("GET %s after a rotation = %d: %s", privatePath, response.Code, response.Body.String())
	}
	exchanges := tokenRequests(upstream)
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("acme-bot:"+rotatedPassword))
	if last := exchanges[len(exchanges)-1]; last.authorization != want {
		t.Errorf("the exchange after the rotation carried %q, want the new password", last.authorization)
	}
	if lookups := plane.lookups.Load(); lookups != 2 {
		t.Errorf("the control plane was asked %d times, want once more after the old password went", lookups)
	}
}
