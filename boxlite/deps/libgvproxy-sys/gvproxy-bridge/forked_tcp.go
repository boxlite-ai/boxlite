package main

// forked_tcp.go — TCP forwarder with custom dial function.
//
// This is a Kubernetes-style fork of forwarder.TCP() from gvisor-tap-vsock.
// Instead of patching the vendored code, we provide our own version that
// accepts a DialFunc parameter for routing through the Rust proxy.
//
// The original forwarder.TCP() hardcodes net.Dial. Our version uses the
// provided dialFunc, falling back to net.Dial when nil.

import (
	"context"
	"fmt"
	"net"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
	logrus "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/waiter"
)

// DialFunc is a function that dials a network connection.
// When nil, net.Dial is used (no proxy).
type DialFunc func(network, address string) (net.Conn, error)

// TCPWithDial creates a TCP forwarder that uses the provided dial function
// for outbound connections. This is identical to forwarder.TCP() except
// it accepts a custom dialer for proxy routing.
func TCPWithDial(s *stack.Stack, nat map[tcpip.Address]tcpip.Address,
	natLock *sync.Mutex, ec2MetadataAccess bool, dialFn DialFunc) *tcp.Forwarder {

	if dialFn == nil {
		dialFn = net.Dial
	}

	return tcp.NewForwarder(s, 0, 10, func(r *tcp.ForwarderRequest) {
		localAddress := r.ID().LocalAddress

		_, linkLocalNet, _ := net.ParseCIDR("169.254.0.0/16")
		linkLocalSubnet, _ := tcpip.NewSubnet(
			tcpip.AddrFromSlice(linkLocalNet.IP),
			tcpip.MaskFromBytes(linkLocalNet.Mask),
		)
		if !ec2MetadataAccess && linkLocalSubnet.Contains(localAddress) {
			r.Complete(true)
			return
		}

		natLock.Lock()
		if replaced, ok := nat[localAddress]; ok {
			localAddress = replaced
		}
		natLock.Unlock()

		outbound, err := dialFn("tcp", fmt.Sprintf("%s:%d", localAddress, r.ID().LocalPort))
		if err != nil {
			logrus.Tracef("dialFn() = %v", err)
			r.Complete(true)
			return
		}

		var wq waiter.Queue
		ep, tcpErr := r.CreateEndpoint(&wq)
		r.Complete(false)
		if tcpErr != nil {
			outbound.Close()
			if _, ok := tcpErr.(*tcpip.ErrConnectionRefused); ok {
				logrus.Debugf("r.CreateEndpoint() = %v", tcpErr)
			} else {
				logrus.Errorf("r.CreateEndpoint() = %v", tcpErr)
			}
			return
		}

		remote := tcpproxy.DialProxy{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return outbound, nil
			},
		}
		remote.HandleConn(gonet.NewTCPConn(&wq, ep))
	})
}
