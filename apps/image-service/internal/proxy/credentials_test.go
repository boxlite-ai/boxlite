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

type passwordReaderFunc func(context.Context, string) (string, error)

func (f passwordReaderFunc) Read(ctx context.Context, version string) (string, error) {
	return f(ctx, version)
}

func TestSecretRetiredDuringChallengeRefreshesCredentialOnce(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		unreadable bool
		forbidden  bool
		status     int
		reads      int
	}{
		{"rotated", false, false, http.StatusOK, 2},
		{"replacement unreadable", true, false, http.StatusServiceUnavailable, 2},
		{"refresh forbidden", false, true, http.StatusForbidden, 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			const version, password = "registry-credential-rotated", "rotated-test-token"
			upstream := newStubUpstream(t)
			router, proxy, plane, _ := privateProxy(t, upstream)
			available := passwords{}
			if !scenario.unreadable {
				available[version] = password
			}
			reads := 0
			proxy.credentials.secrets = passwordReaderFunc(func(ctx context.Context, version string) (string, error) {
				reads++
				return available.Read(ctx, version)
			})
			upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/token" && r.Header.Get("Authorization") == "" {
					// The lookup already chose the old version; retire it during the challenge round trip.
					plane.logins.Store(acmeOrg+" ghcr.io acme/app", version)
					if scenario.forbidden {
						plane.hosting.Delete(runnerKey + " " + acmeOrg)
					}
				}
				upstream.serve(w, r)
			})

			response := pull(router, http.MethodGet, privatePath, runnerKey)

			if response.Code != scenario.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, scenario.status, response.Body.String())
			}
			if reads != scenario.reads {
				t.Errorf("secret reads = %d, want %d", reads, scenario.reads)
			}
			if lookups := plane.lookups.Load(); lookups != 2 {
				t.Errorf("credential lookups = %d, want 2", lookups)
			}
			exchanges := tokenRequests(upstream)
			if scenario.status == http.StatusOK {
				want := "Basic " + base64.StdEncoding.EncodeToString([]byte("acme-bot:"+password))
				if len(exchanges) != 1 || exchanges[0].authorization != want {
					t.Fatalf("exchanges = %+v, want one with the replacement login", exchanges)
				}
			} else if len(exchanges) != 0 {
				t.Errorf("failed refresh exchanged %d tokens", len(exchanges))
			}
		})
	}
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

	// Acme's runner buys a token; the stranger's pull arrives while it is warm.
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

func TestARotatedLoginIsPresentedAfterBearerExpiry(t *testing.T) {
	upstream := newStubUpstream(t)
	router, proxy, plane, moment := privateProxy(t, upstream)
	pull(router, http.MethodGet, privatePath, runnerKey)

	// After the bearer expires, authentication must use the committed replacement.
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

func TestRegistryRotationInvalidatesWarmTokensAcrossProxies(t *testing.T) {
	upstream := newStubUpstream(t)
	first, firstProxy, plane, _ := privateProxy(t, upstream)
	second, secondProxy := testProxy(t, upstream, plane, "ghcr.io")
	secondProxy.credentials = newCredentialFinder(plane.client(), passwords{acmeVersion: acmePassword}, time.Minute)
	for _, router := range []*gin.Engine{first, second} {
		if response := pull(router, http.MethodGet, privatePath, runnerKey); response.Code != http.StatusOK {
			t.Fatalf("warm-up pull = %d", response.Code)
		}
	}
	if got := len(tokenRequests(upstream)); got != 2 {
		t.Fatalf("warm-up exchanges = %d, want one per proxy", got)
	}

	const version, password = "registry-credential-replacement", "replacement-test-token"
	plane.logins.Store(acmeOrg+" ghcr.io acme/app", version)
	// Retirement can fail after update commits. Both secrets remain readable,
	// and neither proxy's bearer TTL has advanced.
	for _, proxy := range []*registryProxy{firstProxy, secondProxy} {
		proxy.credentials.secrets = passwords{acmeVersion: acmePassword, version: password}
	}
	for index, router := range []*gin.Engine{first, second} {
		response := pull(router, http.MethodGet, privatePath, runnerKey)
		if response.Code != http.StatusOK {
			t.Fatalf("proxy %d after rotation = %d: %s", index, response.Code, response.Body.String())
		}
		exchanges := tokenRequests(upstream)
		if len(exchanges) != 3+index {
			t.Fatalf("proxy %d reused a pre-rotation bearer: exchanges = %d, want %d", index, len(exchanges), 3+index)
		}
		want := "Basic " + base64.StdEncoding.EncodeToString([]byte("acme-bot:"+password))
		if exchanges[len(exchanges)-1].authorization != want {
			t.Fatal("replacement exchange did not use the updated login")
		}
	}
}

func TestWarmPrivateTokenFailsClosedWhenVersionCannotBeChecked(t *testing.T) {
	upstream := newStubUpstream(t)
	router, proxy, plane, _ := privateProxy(t, upstream)
	if response := pull(router, http.MethodGet, privatePath, runnerKey); response.Code != http.StatusOK {
		t.Fatalf("warm-up pull = %d", response.Code)
	}
	proxy.credentials.api = plane.unreachable()
	response := pull(router, http.MethodGet, privatePath, runnerKey)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unchecked warm bearer served a pull: status = %d, want 503", response.Code)
	}
}
