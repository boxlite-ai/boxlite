package main

// forked_tcp.go — TCP forwarder with AllowNet filtering + SNI/Host inspection.
//
// Fork of gvisor-tap-vsock@v0.8.7/pkg/services/forwarder/tcp.go.
// Two paths:
//   - Standard: IP/CIDR match or no filter → upstream flow (Dial → Accept → relay)
//   - Inspect:  port 443/80 with hostname rules → Accept → Peek SNI/Host → check → Dial → relay
//
// When filter is nil: identical to upstream (zero overhead).

import (
	"bufio"
	"context"
	"fmt"
	"io"
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

// TCPWithFilter creates a TCP forwarder that checks the filter before allowing
// outbound connections. For port 443/80 with hostname rules, it inspects
// TLS SNI / HTTP Host headers to match against the allowlist.
func TCPWithFilter(s *stack.Stack, nat map[tcpip.Address]tcpip.Address,
	natLock *sync.Mutex, ec2MetadataAccess bool, filter *TCPFilter) *tcp.Forwarder {

	return tcp.NewForwarder(s, 0, 10, func(r *tcp.ForwarderRequest) {
		localAddress := r.ID().LocalAddress

		// Block link-local (169.254.0.0/16) unless EC2 metadata access enabled
		_, linkLocalNet, _ := net.ParseCIDR("169.254.0.0/16")
		linkLocalSubnet, _ := tcpip.NewSubnet(
			tcpip.AddrFromSlice(linkLocalNet.IP),
			tcpip.MaskFromBytes(linkLocalNet.Mask),
		)
		if !ec2MetadataAccess && linkLocalSubnet.Contains(localAddress) {
			r.Complete(true)
			return
		}

		// NAT translation
		natLock.Lock()
		if replaced, ok := nat[localAddress]; ok {
			localAddress = replaced
		}
		natLock.Unlock()

		addr4 := localAddress.As4()
		destIP := net.IP(addr4[:])
		destPort := r.ID().LocalPort
		destAddr := fmt.Sprintf("%s:%d", localAddress, destPort)

		// No filter: standard upstream flow
		if filter == nil {
			standardForward(r, destAddr)
			return
		}

		// IP/CIDR match: standard upstream flow (allowed)
		if filter.MatchesIP(destIP) {
			standardForward(r, destAddr)
			return
		}

		// Port 443/80 with hostname rules: inspect SNI/Host
		if filter.HasHostnameRules() && (destPort == 443 || destPort == 80) {
			inspectAndForward(r, destAddr, destPort, filter)
			return
		}

		// No matching rule: block
		logrus.WithFields(logrus.Fields{
			"dst_ip":   destIP,
			"dst_port": destPort,
		}).Info("allowNet TCP: blocked (no matching rule)")
		r.Complete(true) // RST
	})
}

// standardForward is the upstream flow: Dial → CreateEndpoint → relay.
func standardForward(r *tcp.ForwarderRequest, destAddr string) {
	outbound, err := net.Dial("tcp", destAddr)
	if err != nil {
		logrus.Tracef("net.Dial() = %v", err)
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
}

// inspectAndForward: Accept → Peek SNI/Host → check allowlist → Dial → relay.
// The flow is reversed from upstream because we need to read from the guest
// before deciding whether to connect to the upstream server.
func inspectAndForward(r *tcp.ForwarderRequest, destAddr string, destPort uint16, filter *TCPFilter) {
	// Step 1: Accept TCP from guest first (reversed from upstream)
	var wq waiter.Queue
	ep, tcpErr := r.CreateEndpoint(&wq)
	r.Complete(false)
	if tcpErr != nil {
		if _, ok := tcpErr.(*tcpip.ErrConnectionRefused); ok {
			logrus.Debugf("r.CreateEndpoint() = %v", tcpErr)
		} else {
			logrus.Errorf("r.CreateEndpoint() = %v", tcpErr)
		}
		return
	}
	guestConn := gonet.NewTCPConn(&wq, ep)

	// Step 2: Peek to extract hostname (non-consuming read via bufio.Reader)
	br := bufio.NewReaderSize(guestConn, 16384)
	var hostname string
	if destPort == 443 {
		hostname = peekClientHelloSNI(br)
	} else {
		hostname = peekHTTPHost(br)
	}

	// Step 3: Check allowlist
	if hostname == "" || !filter.MatchesHostname(hostname) {
		logrus.WithFields(logrus.Fields{
			"dst":      destAddr,
			"hostname": hostname,
		}).Info("allowNet TCP: blocked (hostname not in allowlist)")
		guestConn.Close()
		return
	}

	logrus.WithFields(logrus.Fields{
		"dst":      destAddr,
		"hostname": hostname,
	}).Debug("allowNet TCP: allowed by hostname")

	// Step 4: Dial upstream
	outbound, err := net.Dial("tcp", destAddr)
	if err != nil {
		logrus.WithField("error", err).Trace("allowNet TCP: upstream dial failed")
		guestConn.Close()
		return
	}

	// Step 5: Relay using tcpproxy.DialProxy (same as standardForward).
	// Wrap guestConn with the bufio.Reader so peeked bytes are replayed
	// automatically when DialProxy copies guest→server.
	bufferedGuest := &bufferedConn{Conn: guestConn, reader: br}

	remote := tcpproxy.DialProxy{
		DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
			return outbound, nil
		},
	}
	remote.HandleConn(bufferedGuest)
}

// bufferedConn wraps a net.Conn with a bufio.Reader for Read operations.
// This ensures peeked bytes (from SNI/Host inspection) are replayed to the
// upstream server during the relay phase.
type bufferedConn struct {
	net.Conn
	reader io.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}
