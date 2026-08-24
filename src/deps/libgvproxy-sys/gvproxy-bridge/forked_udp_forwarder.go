package main

// forked_udp_forwarder.go — Fork of gvisor-tap-vsock's forwarder.UDP that
// rate-limits the ingress (host → guest) direction.
//
// forwarder.UDP (pkg/services/forwarder/udp.go) dials the real host UDP socket
// internally with no injection point, so shaping the download direction means
// forking that one function and wrapping the dialed conn's reads. NewUDPProxy,
// Run, and the buffer/timeout constants are all exported, so only the ~20-line
// autoStoppingListener (unexported upstream) is copied too.

import (
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/services/forwarder"
	logrus "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"
)

// UDPWithRateLimit mirrors forwarder.UDP but wraps the dialed host-side conn so
// its reads (host → guest, the download direction) are shaped by the download
// token bucket. Egress (guest → host) stays policed in UDPWithFilter
// (forked_udp.go) — UDP has no flow control, so over-limit egress is dropped
// rather than delayed.
func UDPWithRateLimit(s *stack.Stack, nat map[tcpip.Address]tcpip.Address,
	natLock *sync.Mutex, rl *netRateLimiter) *udp.Forwarder {
	return udp.NewForwarder(s, func(r *udp.ForwarderRequest) {
		localAddress := r.ID().LocalAddress

		if linkLocalSubnet.Contains(localAddress) || localAddress == header.IPv4Broadcast {
			return
		}

		natLock.Lock()
		if replaced, ok := nat[localAddress]; ok {
			localAddress = replaced
		}
		natLock.Unlock()

		var wq waiter.Queue
		ep, tcpErr := r.CreateEndpoint(&wq)
		if tcpErr != nil {
			if _, ok := tcpErr.(*tcpip.ErrConnectionRefused); ok {
				// transient error
				logrus.Debugf("r.CreateEndpoint() = %v", tcpErr)
			} else {
				logrus.Errorf("r.CreateEndpoint() = %v", tcpErr)
			}
			return
		}

		p, _ := forwarder.NewUDPProxy(&autoStoppingListener{underlying: gonet.NewUDPConn(&wq, ep)}, func() (net.Conn, error) {
			hostPort := net.JoinHostPort(localAddress.String(), strconv.Itoa(int(r.ID().LocalPort)))
			conn, err := net.Dial("udp", hostPort)
			if err != nil {
				return nil, err
			}
			if rl != nil {
				// Shape only the download (read) direction. Egress is policed
				// in UDPWithFilter, so the write direction stays unthrottled.
				conn = throttleConn(conn, rl.download, nil)
			}
			return conn, nil
		})
		go func() {
			p.Run()

			// note that at this point packets that are sent to the current forwarder session
			// will be dropped. We will start processing the packets again when we get a new
			// forwarder request.
			ep.Close()
		}()
	})
}

// autoStoppingListener mirrors forwarder's unexported autoStoppingListener: it
// refreshes the guest-side conn's read deadline on every ReadFrom/WriteTo so an
// idle UDP session stops after forwarder.UDPConnTrackTimeout instead of leaking.
type autoStoppingListener struct {
	underlying *gonet.UDPConn
}

func (l *autoStoppingListener) ReadFrom(b []byte) (int, net.Addr, error) {
	_ = l.underlying.SetReadDeadline(time.Now().Add(forwarder.UDPConnTrackTimeout))
	return l.underlying.ReadFrom(b)
}

func (l *autoStoppingListener) WriteTo(b []byte, addr net.Addr) (int, error) {
	_ = l.underlying.SetReadDeadline(time.Now().Add(forwarder.UDPConnTrackTimeout))
	return l.underlying.WriteTo(b, addr)
}

func (l *autoStoppingListener) SetReadDeadline(t time.Time) error {
	return l.underlying.SetReadDeadline(t)
}

func (l *autoStoppingListener) Close() error {
	return l.underlying.Close()
}
