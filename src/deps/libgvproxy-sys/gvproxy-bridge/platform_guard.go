package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sync"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
)

// The platform guard is fixed by host startup and shared across Box revisions.
type platformGuard struct {
	protected []netip.Prefix
	cloud     bool
	guest     netip.Prefix
	epoch     *cloudGuardEpoch
}

func compilePlatformGuard(values []string, cloud bool, subnet string) (platformGuard, error) {
	guard := platformGuard{cloud: cloud}
	if cloud {
		guest, err := netip.ParsePrefix(subnet)
		if err != nil || !guest.Addr().Is4() {
			return platformGuard{}, fmt.Errorf("Cloud platform guard requires an IPv4 guest subnet")
		}
		guard.guest = guest.Masked()
	}
	protected, err := guardinventory.IPv4Prefixes(values)
	guard.protected = protected
	return guard, err
}

func (guard platformGuard) active() bool {
	return !guard.cloud || (guard.epoch != nil && guard.epoch.active())
}

func (guard platformGuard) trafficContext(parent context.Context) context.Context {
	if guard.epoch != nil {
		return guard.epoch.ctx
	}
	return parent
}

func (guard platformGuard) bindContext(parent context.Context) (context.Context, func()) {
	if guard.epoch == nil {
		return parent, func() {}
	}
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(guard.epoch.ctx, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

func (guard platformGuard) track(conn net.Conn) (net.Conn, error) {
	if !guard.active() {
		_ = conn.Close()
		return nil, net.ErrClosed
	}
	if guard.epoch == nil {
		return conn, nil
	}
	closeConn := sync.OnceValue(conn.Close)
	stop := context.AfterFunc(guard.epoch.ctx, func() { _ = closeConn() })
	return &guardedConn{Conn: conn, epoch: guard.epoch, stop: stop, close: closeConn}, nil
}

func (p *outboundPolicyController) runGuestLink(ctx context.Context, conn net.Conn, prefixLen int,
	rate *RateLimitConfig, accept func(context.Context, net.Conn) error) error {
	guard := p.guard
	conn, err := guard.track(conn)
	if err != nil {
		return err
	}
	var allowIPv6 func() bool
	if p.config.IPv6Link != nil {
		allowIPv6 = p.config.IPv6Link.AllowTraffic
	}
	return runGuestLink(guard.trafficContext(ctx), conn, prefixLen, rate, allowIPv6, accept)
}

type guardedConn struct {
	net.Conn
	epoch *cloudGuardEpoch
	stop  func() bool
	close func() error
}

func (c *guardedConn) Close() error {
	c.stop()
	return c.close()
}

func (c *guardedConn) Read(dst []byte) (int, error) {
	if !c.epoch.active() {
		return 0, net.ErrClosed
	}
	return c.Conn.Read(dst)
}

func (c *guardedConn) Write(src []byte) (int, error) {
	if !c.epoch.active() {
		return 0, net.ErrClosed
	}
	return c.Conn.Write(src)
}

func (guard platformGuard) denies(address netip.Addr) bool {
	address = address.Unmap()
	for _, prefix := range guard.protected {
		if prefix.Contains(address) {
			return true
		}
	}
	if !guard.cloud {
		return false
	}
	if !address.Is4() || guard.guest.Contains(address) {
		return true
	}
	_, restricted := unroutableEgress(address.AsSlice())
	return restricted
}

func (guard platformGuard) requiresCheckedUDP() bool {
	return guard.cloud || len(guard.protected) != 0
}
