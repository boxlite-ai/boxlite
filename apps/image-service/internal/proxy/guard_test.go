// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRoutableRefusesEverythingOffThePublicInternet(t *testing.T) {
	cases := []struct {
		address  string
		routable bool
		why      string
	}{
		{"169.254.169.254", false, "the cloud metadata service"},
		{"169.254.1.1", false, "link-local"},
		{"127.0.0.1", false, "loopback"},
		{"::1", false, "loopback, v6"},
		{"10.1.2.3", false, "private"},
		{"172.16.0.1", false, "private"},
		{"192.168.1.1", false, "private"},
		{"fd00::1", false, "unique local, v6's private range"},
		{"fe80::1", false, "link-local, v6"},
		{"0.0.0.0", false, "unspecified"},
		{"100.64.0.1", false, "carrier-grade NAT, a provider's own network"},
		{"240.0.0.1", false, "reserved and routed nowhere"},
		{"224.0.0.1", false, "multicast"},
		{"0.1.2.3", false, "\"this network\", which a host reads as itself"},
		{"64:ff9b::a00:1", false, "NAT64, which maps a private v4 address back in"},
		{"2002:0a00:0001::1", false, "6to4, likewise"},
		// Reserved for benchmarking, so not globally routable — but VPN and
		// split-DNS clients hand out addresses from it for ordinary public
		// hosts, and refusing it would refuse every pull behind one.
		{"198.18.0.246", true, "where a split-DNS resolver may put ghcr.io"},
		{"140.82.121.34", true, "a public address, which is where registries live"},
		{"2606:4700::1111", true, "a public address, v6"},
	}

	for _, testCase := range cases {
		t.Run(testCase.address, func(t *testing.T) {
			ip := net.ParseIP(testCase.address)
			if ip == nil {
				t.Fatalf("%q is not an address", testCase.address)
			}
			if got := routable(ip); got != testCase.routable {
				t.Errorf("routable(%s) = %v, want %v — %s", testCase.address, got, testCase.routable, testCase.why)
			}
		})
	}
}

// allowLoopback is what a test needs to reach a stub, and what production must
// never do: the stubs live on the addresses the rule exists to refuse.
func allowLoopback(ip net.IP) bool { return ip.IsLoopback() || routable(ip) }

// A registry hands a blob off with a 302 and chooses the address itself, so the
// address rule is worth nothing if it only covers the URL this proxy composed.
func TestUpstreamClientRefusesARedirectOffThePublicInternet(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer upstream.Close()

	_, err := newUpstreamClient(allowLoopback, time.Second).Get(upstream.URL)
	if !errors.Is(err, ErrAddressRefused) {
		t.Fatalf("following the redirect failed with %v, want %v", err, ErrAddressRefused)
	}
}

// A name that resolves to a refused address is refused too. Checking the name
// and then dialing whatever it resolves to a moment later would leave exactly
// the gap this closes.
func TestUpstreamClientRefusesANameThatResolvesOffThePublicInternet(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	// The URL is addressed by name, not by address, so only a rule that runs
	// after resolution can refuse it: localhost is a name, and what it resolves
	// to is what the rule has to judge.
	byName := strings.Replace(upstream.URL, "127.0.0.1", "localhost", 1)
	if byName == upstream.URL {
		t.Fatalf("this test needs a URL addressed by name, got %q", upstream.URL)
	}

	_, err := newUpstreamClient(routable, time.Second).Get(byName)
	if !errors.Is(err, ErrAddressRefused) {
		t.Fatalf("dialing %s failed with %v, want %v", byName, err, ErrAddressRefused)
	}
}

func TestUpstreamClientFollowsARedirectToAnAllowedAddress(t *testing.T) {
	blob := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("layer bytes"))
	}))
	defer blob.Close()

	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, blob.URL, http.StatusFound)
	}))
	defer registry.Close()

	response, err := newUpstreamClient(allowLoopback, time.Second).Get(registry.URL)
	if err != nil {
		t.Fatalf("following the redirect failed: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want the redirected 200", response.StatusCode)
	}
}

func TestUpstreamClientStopsChasingARedirectLoop(t *testing.T) {
	var loop *httptest.Server
	loop = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, loop.URL, http.StatusFound)
	}))
	defer loop.Close()

	if _, err := newUpstreamClient(allowLoopback, time.Second).Get(loop.URL); err == nil {
		t.Fatal("a redirect loop was followed forever")
	}
}
