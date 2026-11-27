package main

import (
	"context"
	"net"
	"net/netip"
	"syscall"

	"golang.org/x/sys/unix"
)

func (uplink cloudIPv6Uplink) dial(ctx context.Context, network, address string) (net.Conn, error) {
	source := uplink.source.AsSlice()
	dialer := net.Dialer{
		Timeout: upstreamDialTimeout,
		Control: func(_, _ string, socket syscall.RawConn) error {
			var bindErr error
			if err := socket.Control(func(fd uintptr) {
				bindErr = unix.BindToDevice(int(fd), uplink.device)
			}); err != nil {
				return err
			}
			return bindErr
		},
	}
	if network == "udp6" {
		dialer.LocalAddr = &net.UDPAddr{IP: source}
	} else {
		dialer.LocalAddr = &net.TCPAddr{IP: source}
	}
	return dialer.DialContext(ctx, network, address)
}

func (uplink cloudIPv6Uplink) checkRoute(ctx context.Context, destination netip.AddrPort) error {
	socket, err := uplink.dial(ctx, "udp6", destination.String())
	if err != nil {
		return err
	}
	return socket.Close()
}
