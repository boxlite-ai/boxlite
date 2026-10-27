// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"syscall"
	"time"
)

// maxRedirects bounds how far a blob may be chased. Registries hand blobs off
// to a CDN in one hop; more than a few means a loop or a redirector being used
// as one.
const maxRedirects = 5

// ErrAddressRefused means a connection was to an address the registry proxy
// will not reach.
var ErrAddressRefused = errors.New("address refused")

// newUpstreamClient builds the client every upstream request rides on: pulls,
// redirects chased from them, and token exchanges alike.
//
// The address check lives in the dialer rather than beside each request on
// purpose. A registry hands a blob off with a 302, and the address it names is
// chosen by the registry, not by us — so anything that checks only the URL we
// composed protects nothing. Checking in Control puts the decision after DNS
// resolution and before connect, on the resolved address, which also closes the
// gap between deciding a name is safe and dialing whatever it resolves to a
// moment later.
func newUpstreamClient(reachable func(net.IP) bool, timeout time.Duration) *http.Client {
	return upstreamClient(guardedDialer(reachable, timeout).DialContext, timeout)
}

func guardedDialer(reachable func(net.IP) bool, timeout time.Duration) *net.Dialer {
	return &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return fmt.Errorf("%w: %q is not an address", ErrAddressRefused, address)
			}
			ip := net.ParseIP(host)
			if ip == nil {
				return fmt.Errorf("%w: %q did not resolve to an address", ErrAddressRefused, host)
			}
			if !reachable(ip) {
				return fmt.Errorf("%w: %s", ErrAddressRefused, ip)
			}
			return nil
		},
	}
}

// upstreamClient is the policy every upstream request rides on, apart from how
// it reaches the address. A test substitutes the dialer and inherits the rest,
// so the transport it exercises cannot quietly differ from the one that ships.
func upstreamClient(dial func(context.Context, string, string) (net.Conn, error), timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: dial,
			// Left on, the transport offers gzip on any request that did not
			// ask for an encoding itself, then decodes the answer and drops
			// Content-Encoding and Content-Length as it goes. That is a
			// convenience for a client reading a body and a defect for anything
			// relaying one: the caller would receive different bytes under a
			// digest that no longer covers them. What the caller asks for is
			// forwarded and its answer passed back untouched instead.
			DisableCompression:  true,
			ForceAttemptHTTP2:   true,
			MaxIdleConns:        100,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: timeout,
			// Bounds the wait for headers only. A blob streams for minutes once
			// it starts, so the body is left to the caller, never to a timeout
			// here.
			ResponseHeaderTimeout: timeout,
			ExpectContinueTimeout: time.Second,
		},
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("stopped after %d redirects", maxRedirects)
			}
			return nil
		},
	}
}

// routable reports whether the registry proxy may open a connection to ip.
//
// Everything that is not a public address is refused. A registry has no reason
// to send a pull to one, and the addresses that would be reached instead are
// the cloud metadata service, the node's own services, and whatever else shares
// the network — which is the whole of what a server-side request forgery is
// after.
func routable(ip net.IP) bool {
	switch {
	case ip.IsLoopback(), ip.IsPrivate(), ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		return false
	case ip.IsUnspecified(), ip.IsMulticast(), ip.IsInterfaceLocalMulticast():
		return false
	}
	// net.IP's own predicates cover loopback, the RFC 1918 ranges and IPv6's
	// unique local addresses. The rest are blocks that reach a neighbouring
	// network, or map one of the blocks above back in.
	for _, block := range offInternet {
		if block.Contains(ip) {
			return false
		}
	}
	return true
}

// offInternet is what the rule adds to net.IP's own predicates.
//
// The test is "does this reach a network we are on", not "is this globally
// routable". The two are not the same, and the difference is not academic:
// 198.18.0.0/15 is reserved for benchmarking and fails the second test, but VPN
// and split-DNS clients hand out addresses from it for ordinary public hosts —
// on a developer machine running one, ghcr.io resolves into it. Refusing that
// range would refuse every pull and explain itself as an address violation.
var offInternet = []*net.IPNet{
	mustParseCIDR("0.0.0.0/8"),     // RFC 1122, "this network" — a host may read it as itself
	mustParseCIDR("100.64.0.0/10"), // RFC 6598, carrier-grade NAT — the equipment between us and the internet
	mustParseCIDR("240.0.0.0/4"),   // RFC 1112, reserved; usable as a destination by nothing
	mustParseCIDR("64:ff9b::/96"),  // RFC 6052, NAT64, which maps the ranges above back in
	mustParseCIDR("2002::/16"),     // RFC 3056, 6to4, likewise
}

func mustParseCIDR(notation string) *net.IPNet {
	_, network, err := net.ParseCIDR(notation)
	if err != nil {
		panic("proxy: unparsable CIDR " + notation)
	}
	return network
}
