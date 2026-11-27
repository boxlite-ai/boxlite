//go:build !linux

package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
)

func (cloudIPv6Uplink) dial(context.Context, string, string) (net.Conn, error) {
	return nil, fmt.Errorf("Cloud IPv6 egress requires Linux")
}

func (cloudIPv6Uplink) checkRoute(context.Context, netip.AddrPort) error {
	return fmt.Errorf("Cloud IPv6 egress requires Linux")
}
