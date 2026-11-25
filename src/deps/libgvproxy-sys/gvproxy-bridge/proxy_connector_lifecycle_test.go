package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
)

type proxyDeadlineConn struct {
	net.Conn
	setDeadline func(time.Time) error
}

func (c proxyDeadlineConn) SetDeadline(deadline time.Time) error {
	return c.setDeadline(deadline)
}

func TestProxyConnector_Handoff(t *testing.T) {
	for _, phase := range []string{"before-reply", "during-clear", "clear-error"} {
		t.Run(phase, func(t *testing.T) {
			cfg := proxyTestConfig("http")
			atBoundary := make(chan struct{})
			release := make(chan struct{})
			peer := startProxyTestPeer(t, func(conn *net.TCPConn) error {
				if err := readTestProxyCONNECT(conn, "93.184.216.34:443", ""); err != nil {
					return err
				}
				if phase == "before-reply" {
					close(atBoundary)
				} else if _, err := io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\n"); err != nil {
					return err
				}
				return requirePeerClose(conn)
			})
			dial := proxyTestDial(peer, cfg.endpoint)
			connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
				raw, err := dial(ctx, network, address)
				if err != nil {
					return nil, err
				}
				return proxyDeadlineConn{Conn: raw, setDeadline: func(deadline time.Time) error {
					if deadline.IsZero() {
						close(atBoundary)
						<-release
						if phase == "clear-error" {
							return errors.New("synthetic deadline clear failure")
						}
					}
					return raw.SetDeadline(deadline)
				}}, nil
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			type setupResult struct {
				conn net.Conn
				err  error
			}
			result := make(chan setupResult, 1)
			go func() {
				conn, err := connect(ctx, proxyTestTarget(proxyTestFirstIP))
				result <- setupResult{conn, err}
			}()
			select {
			case <-atBoundary:
			case <-time.After(5 * time.Second):
				close(release)
				t.Fatal("setup did not reach the selected boundary")
			}
			var want error = proxyHandshakeFailed
			if phase != "clear-error" {
				cancel()
				// The cancellation callback must close the peer even while
				// SetDeadline is still waiting to finish.
				peer.check(t)
				want = context.Canceled
			}
			close(release)
			select {
			case got := <-result:
				requireProxyFailure(t, got.conn, got.err, want)
			case <-time.After(5 * time.Second):
				t.Fatal("setup did not finish after releasing the boundary")
			}
			if phase == "clear-error" {
				peer.check(t)
			}
		})
	}
}

func TestProxyConnector_SharedHTTPSDeadline(t *testing.T) {
	tlsConfig, roots := proxyTestTLS(t, newTestCA(t), proxyTestTLSName)
	cfg := proxyTestConfig("https")
	cfg.roots = roots
	for _, stall := range []string{"tls", "headers"} {
		t.Run(stall, func(t *testing.T) {
			peer := startProxyTestPeer(t, func(raw *net.TCPConn) error {
				if stall == "tls" {
					// Read the ClientHello as opaque bytes without replying.
					_, err := io.Copy(io.Discard, raw)
					return err
				}
				timer := time.NewTimer(100 * time.Millisecond)
				defer timer.Stop()
				<-timer.C
				conn := tls.Server(raw, tlsConfig)
				if err := readTestProxyCONNECT(conn, "93.184.216.34:443", ""); err != nil {
					return err
				}
				return requirePeerClose(conn)
			})
			ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
			defer cancel()
			deadline, _ := ctx.Deadline()
			var dialDeadline time.Time
			var deadlines []time.Time
			dial := proxyTestDial(peer, cfg.endpoint)
			connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
				dialDeadline, _ = ctx.Deadline()
				timer := time.NewTimer(100 * time.Millisecond)
				defer timer.Stop()
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-timer.C:
				}
				raw, err := dial(ctx, network, address)
				if err != nil {
					return nil, err
				}
				return proxyDeadlineConn{Conn: raw, setDeadline: func(deadline time.Time) error {
					deadlines = append(deadlines, deadline)
					return raw.SetDeadline(deadline)
				}}, nil
			})
			conn, err := connect(ctx, proxyTestTarget(proxyTestFirstIP))
			requireProxyFailure(t, conn, err, proxyTimeout)
			if !dialDeadline.Equal(deadline) || len(deadlines) != 1 || !deadlines[0].Equal(deadline) {
				t.Fatalf("original %v, dial %v, socket deadlines %v", deadline, dialDeadline, deadlines)
			}
			peer.check(t)
		})
	}
}

func TestProxyConnector_SharedCandidateDeadline(t *testing.T) {
	cfg := proxyTestConfig("socks5")
	first := proxyTestSOCKSPeer(t, 34, []byte{5, 4, 0, 1, 0, 0, 0, 0, 0, 0}, false)
	second := proxyTestSOCKSPeer(t, 35, nil, false)
	var deadlines []time.Time
	connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
		deadline, _ := ctx.Deadline()
		deadlines = append(deadlines, deadline)
		if len(deadlines) == 1 {
			timer := time.NewTimer(150 * time.Millisecond)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return proxyTestDial(first, cfg.endpoint)(ctx, network, address)
		}
		return proxyTestDial(second, cfg.endpoint)(ctx, network, address)
	})
	dialer, direct := proxyTestByName(t, connect)
	ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
	defer cancel()
	deadline, _ := ctx.Deadline()
	conn, err := dialer.DialHost(ctx, proxyTestTarget(proxyTestFirstIP))
	requireProxyFailure(t, conn, err, proxyTimeout)
	if len(deadlines) != 2 || !deadlines[0].Equal(deadline) || !deadlines[1].Equal(deadline) || *direct != 0 {
		t.Fatalf("shared deadline %v, proxy dial deadlines %v, direct dials %d", deadline, deadlines, *direct)
	}
	first.check(t)
	second.check(t)
}

func TestProxyConnector_RefusedProxy(t *testing.T) {
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	cfg := proxyTestConfig("http")
	var proxyDials int
	connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, dest string) (net.Conn, error) {
		proxyDials++
		return proxyTestDial(proxyTestPeer{address: address}, cfg.endpoint)(ctx, network, dest)
	})
	dialer, direct := proxyTestByName(t, connect)
	conn, err := dialer.DialHost(context.Background(), proxyTestTarget(proxyTestFirstIP))
	requireProxyFailure(t, conn, err, proxyUnreachable)
	if proxyDials != 1 || *direct != 0 {
		t.Fatalf("proxy dials=%d, direct dials=%d", proxyDials, *direct)
	}
}

func TestProxyConnector_RelayAndCleanup(t *testing.T) {
	for _, stop := range []string{"target-close", "owner-close"} {
		t.Run(stop, func(t *testing.T) {
			targetPeer := make(chan string, 1)
			proxySource := make(chan string, 1)
			target := startProxyTestPeer(t, func(conn *net.TCPConn) error {
				targetPeer <- conn.RemoteAddr().String()
				if _, err := io.WriteString(conn, "target to guest"); err != nil {
					return err
				}
				if err := readProxyTestBytes(conn, []byte("guest to target")); err != nil {
					return err
				}
				if _, err := io.WriteString(conn, "target acknowledgement"); err != nil {
					return err
				}
				if stop == "owner-close" {
					return requirePeerClose(conn)
				}
				return nil
			})
			peer := startProxyTestPeer(t, func(conn *net.TCPConn) error {
				if err := readTestProxyCONNECT(conn, "93.184.216.34:443", ""); err != nil {
					return err
				}
				upstream, err := net.DialTimeout("tcp4", target.address, time.Second)
				if err != nil {
					return err
				}
				defer upstream.Close()
				proxySource <- upstream.LocalAddr().String()
				if _, err := io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\n"); err != nil {
					return err
				}
				copies := make(chan struct{}, 2)
				go func() { _, _ = io.Copy(conn, upstream); copies <- struct{}{} }()
				go func() { _, _ = io.Copy(upstream, conn); copies <- struct{}{} }()
				<-copies
				_ = conn.Close()
				_ = upstream.Close()
				<-copies
				return nil
			})
			cfg := proxyTestConfig("http")
			dialer, direct := proxyTestByName(t, mustProxyConnector(t, cfg, proxyTestDial(peer, cfg.endpoint)))
			tunnel, err := dialer.DialHost(context.Background(), proxyTestTarget(proxyTestFirstIP))
			if err != nil {
				t.Fatal(err)
			}
			defer tunnel.Close()
			guest, ingress := net.Pipe()
			defer guest.Close()
			relay := tcpproxy.DialProxy{DialContext: func(context.Context, string, string) (net.Conn, error) {
				return tunnel, nil
			}}
			forwarded := make(chan struct{})
			go func() {
				relay.HandleConn(ingress)
				close(forwarded)
			}()
			requireProxyBytes(t, guest, "target to guest")
			if _, err := io.WriteString(guest, "guest to target"); err != nil {
				t.Fatal(err)
			}
			requireProxyBytes(t, guest, "target acknowledgement")
			if want, got := <-proxySource, <-targetPeer; got != want {
				t.Fatalf("target peer %q, want selected proxy socket %q", got, want)
			}
			if stop == "owner-close" {
				_ = tunnel.Close()
			}
			if err := requirePeerClose(guest); err != nil {
				t.Fatal(fmt.Errorf("guest teardown: %w", err))
			}
			select {
			case <-forwarded:
			case <-time.After(5 * time.Second):
				t.Fatal("production relay did not finish")
			}
			target.check(t)
			peer.check(t)
			if *direct != 0 {
				t.Fatalf("unexpected direct dials: %d", *direct)
			}
		})
	}
}
