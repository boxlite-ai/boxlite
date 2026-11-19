package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"

	"github.com/miekg/dns"
)

// newRegisteredProxyConnector captures the one name that may use the host
// resolver. Callers supply only the business target when opening a tunnel.
func newRegisteredProxyConnector(cfg proxyConnectorConfig, endpoint string, port uint16, resolve resolveFunc, dial dialFunc) (connectFunc, error) {
	if port == 0 {
		return nil, errors.New("invalid registered proxy endpoint")
	}
	literal, parseErr := netip.ParseAddr(endpoint)
	host := literal.Unmap().String()
	if parseErr != nil {
		host = canonicalHostname(endpoint)
		if !validProxyHostname(host) {
			return nil, errors.New("invalid registered proxy hostname")
		}
	}
	cfg.serverName = host
	cfg.endpoint = netip.AddrPort{}
	checked, err := cfg.checked()
	if err != nil {
		return nil, err
	}
	if parseErr == nil {
		if !checked.permitsAddress(literal, false) {
			return nil, errors.New("invalid registered proxy address")
		}
		checked.endpoint = netip.AddrPortFrom(literal.Unmap(), port)
	}
	if resolve == nil {
		resolve = systemResolve
	}
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	return func(ctx context.Context, target egressTarget) (net.Conn, error) {
		ctx, cancel := context.WithTimeout(ctx, upstreamDialTimeout)
		defer cancel()
		if err := proxySetupError(ctx, nil); err != nil {
			return nil, err
		}
		selected := checked
		if !selected.endpoint.IsValid() {
			// An absolute name prevents the host resolver from expanding a
			// registered name through its configured search domains.
			answers, err := resolve(ctx, dns.Fqdn(host))
			if err != nil {
				return nil, proxySetupError(ctx, proxyUnreachable)
			}
			for _, answer := range answers {
				if addr, ok := netip.AddrFromSlice(answer); ok && checked.permitsAddress(addr.Unmap(), false) {
					selected.endpoint = netip.AddrPortFrom(addr.Unmap(), port)
					break
				}
			}
			if !selected.endpoint.IsValid() {
				return nil, proxySetupError(ctx, proxyUnreachable)
			}
		}
		return selected.connect(ctx, dial, target)
	}, nil
}

func validProxyHostname(host string) bool {
	if len(host) > 253 {
		return false
	}
	for label := range strings.SplitSeq(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
				return false
			}
		}
	}
	return true
}
