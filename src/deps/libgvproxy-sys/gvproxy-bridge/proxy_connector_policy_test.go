package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestProxyConnector_AddressPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, endpoint, policyIP, connectionIP, protected string
		dials                                             int
	}{
		{name: "ordinary-public", dials: 1},
		{name: "mapped-public", endpoint: "::ffff:1.1.1.1", connectionIP: "::ffff:93.184.216.34", dials: 1},
		{name: "mapped-loopback-proxy", endpoint: "::ffff:127.0.0.1"},
		{name: "policy-loopback", policyIP: "127.0.0.1"},
		{name: "connection-loopback", connectionIP: "::ffff:127.0.0.1"},
		{name: "no-ipv6-business-target", connectionIP: "2400::1234"},
		{name: "private-proxy", endpoint: "10.0.0.2"},
		{name: "pcp-longest-match", endpoint: "192.0.0.9", dials: 1},
		{name: "pcp-exception-protected", endpoint: "192.0.0.9", protected: "192.0.0.0/24"},
		{name: "neighbor-denied", endpoint: "192.0.0.8"},
		{name: "blank-special-use-denied", endpoint: "192.88.99.42"},
		{name: "teredo-na-denied", endpoint: "2001::1234"},
		{name: "unallocated-native-ipv6", endpoint: "4000::1"},
		{name: "reserved-native-ipv6", endpoint: "3000::1"},
		{name: "allocated-native-ipv6", endpoint: "2400::1234", dials: 1},
		{name: "scoped-native-ipv6", endpoint: "2400::1234%en0"},
		{name: "deployment-host-alias", policyIP: "93.184.216.34", protected: "93.184.216.34/32"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := proxyTestConfig("http")
			target := proxyTestTarget(proxyTestFirstIP)
			if tc.endpoint != "" {
				cfg.endpoint = netip.AddrPortFrom(netip.MustParseAddr(tc.endpoint), cfg.endpoint.Port())
			}
			if tc.policyIP != "" {
				target.PolicyIP = netip.MustParseAddr(tc.policyIP)
			}
			if tc.connectionIP != "" {
				target.ConnectionIP = netip.MustParseAddr(tc.connectionIP)
			}
			if tc.protected != "" {
				cfg.protected = []netip.Prefix{netip.MustParsePrefix(tc.protected)}
			}
			var actualDials int
			connect := mustProxyConnector(t, cfg, func(_ context.Context, network, address string) (net.Conn, error) {
				actualDials++
				want := netip.AddrPortFrom(cfg.endpoint.Addr().Unmap(), cfg.endpoint.Port())
				if network != "tcp" || address != want.String() {
					t.Errorf("unexpected proxy dial %s %s, want %s", network, address, want)
				}
				return nil, errors.New("fixture-pass")
			})
			conn, err := connect(context.Background(), target)
			want := proxyHandshakeFailed
			if tc.dials != 0 {
				want = proxyUnreachable
			}
			requireProxyFailure(t, conn, err, want)
			if actualDials != tc.dials || strings.Contains(err.Error(), "fixture-pass") {
				t.Fatalf("proxy dials %d, want %d, error %v", actualDials, tc.dials, err)
			}
		})
	}
}

func TestProxyConnector_InvalidConfig(t *testing.T) {
	for _, tc := range []struct {
		name, scheme string
		credential   *proxyCredentials
		protected    []netip.Prefix
	}{
		{"scheme", "ftp", nil, nil},
		{"empty", "socks5", &proxyCredentials{"", "fixture-pass"}, nil},
		{"oversized", "http", &proxyCredentials{"fixture-user", strings.Repeat("p", 256)}, nil},
		{"non-printable", "socks5", &proxyCredentials{"fixture-user", "fixture-pass\r"}, nil},
		{"colon", "https", &proxyCredentials{"fixture:user", "fixture-pass"}, nil},
		{"mapped-protected-prefix", "http", nil, []netip.Prefix{netip.MustParsePrefix("::ffff:192.0.2.0/120")}},
		{"invalid-protected-prefix", "http", nil, []netip.Prefix{{}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := proxyTestConfig(tc.scheme)
			cfg.credential, cfg.protected = tc.credential, tc.protected
			connect, err := newProxyConnector(cfg, func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("invalid configuration attempted a dial")
				return nil, nil
			})
			if connect != nil || err == nil || strings.Contains(err.Error(), "fixture-pass") {
				t.Fatalf("invalid configuration result: %v", err)
			}
		})
	}
}

func proxyTestByName(t *testing.T, selected connectFunc) (*egressDialer, *int) {
	t.Helper()
	dialer, err := newEgressDialer(nil, "192.168.127.0/24")
	if err != nil {
		t.Fatal(err)
	}
	dialer.resolve = func(_ context.Context, host string) ([]net.IP, error) {
		if host != "service.example.net" {
			return nil, fmt.Errorf("unexpected business hostname %q", host)
		}
		return []net.IP{proxyTestFirstIP.AsSlice(), proxyTestSecondIP.AsSlice()}, nil
	}
	direct := new(int)
	dialer.dial = func(context.Context, string, string) (net.Conn, error) {
		*direct++
		return nil, errors.New("unexpected direct dial")
	}
	dialer.connect = selected
	return dialer, direct
}

func TestProxyConnector_LocalCandidateDenials(t *testing.T) {
	for _, mode := range []string{"connection", "policy", "proxy"} {
		t.Run(mode, func(t *testing.T) {
			cfg := proxyTestConfig("http")
			target := proxyTestTarget(proxyTestFirstIP)
			cfg.protected = []netip.Prefix{netip.PrefixFrom(proxyTestFirstIP, 32)}
			var peer proxyTestPeer
			switch mode {
			case "connection":
				target.PolicyIP = proxyTestSecondIP
				peer = startProxyTestPeer(t, func(conn *net.TCPConn) error {
					if err := readTestProxyCONNECT(conn, "93.184.216.35:443", ""); err != nil {
						return err
					}
					if _, err := io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\nfrom second"); err != nil {
						return err
					}
					return requirePeerClose(conn)
				})
			case "proxy":
				cfg.protected[0] = netip.PrefixFrom(cfg.endpoint.Addr(), 32)
			}
			var attempts, proxyDials int
			connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
				proxyDials++
				if mode != "connection" {
					return nil, errors.New("unexpected proxy dial")
				}
				return proxyTestDial(peer, cfg.endpoint)(ctx, network, address)
			})
			// The constructed connector owns its protected prefixes.
			cfg.protected[0] = netip.MustParsePrefix("8.8.4.4/32")
			dialer, direct := proxyTestByName(t, func(ctx context.Context, target egressTarget) (net.Conn, error) {
				attempts++
				return connect(ctx, target)
			})
			conn, err := dialer.DialHost(context.Background(), target)
			if mode == "connection" {
				if err != nil {
					t.Fatal(err)
				}
				requireProxyBytes(t, conn, "from second")
				_ = conn.Close()
				peer.check(t)
				if attempts != 2 || proxyDials != 1 {
					t.Fatalf("candidate attempts=%d proxy dials=%d", attempts, proxyDials)
				}
			} else {
				requireProxyFailure(t, conn, err, proxyHandshakeFailed)
				if attempts != 1 || proxyDials != 0 {
					t.Fatalf("terminal attempts=%d proxy dials=%d", attempts, proxyDials)
				}
			}
			if *direct != 0 {
				t.Fatalf("unexpected direct dials: %d", *direct)
			}
		})
	}
}

func proxyTestSOCKSPeer(t *testing.T, lastIPByte byte, reply []byte, halfClose bool) proxyTestPeer {
	t.Helper()
	return startProxyTestPeer(t, func(conn *net.TCPConn) error {
		if err := readProxyTestBytes(conn, []byte{5, 1, 0}); err != nil {
			return err
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			return err
		}
		if err := readProxyTestBytes(conn, []byte{5, 1, 0, 1, 93, 184, 216, lastIPByte, 1, 187}); err != nil {
			return err
		}
		if len(reply) > 0 {
			if _, err := conn.Write(reply); err != nil {
				return err
			}
		}
		if halfClose {
			if err := conn.CloseWrite(); err != nil {
				return err
			}
		}
		return requirePeerClose(conn)
	})
}

func TestProxyConnector_SOCKSCandidateRetry(t *testing.T) {
	for _, tc := range []struct {
		name      string
		reply     []byte
		halfClose bool
		retry     bool
	}{
		{"host-unreachable", []byte{5, 4, 0, 1, 0, 0, 0, 0, 0, 0}, false, true},
		{"connection-refused", []byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0}, false, true},
		{"malformed-retry-status", []byte{5, 4, 1, 1, 0, 0, 0, 0, 0, 0}, false, false},
		{"invalid-address-type", []byte{5, 4, 0, 0x7f, 0, 0, 0, 0, 0, 0}, false, false},
		{"truncated-retry-status", []byte{5, 5, 0, 1, 0, 0, 0, 0, 0}, true, false},
		{"proxy-failure", []byte{5, 1, 0, 1, 0, 0, 0, 0, 0, 0}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := proxyTestConfig("socks5")
			peers := []proxyTestPeer{proxyTestSOCKSPeer(t, 34, tc.reply, tc.halfClose)}
			if tc.retry {
				reply := append([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}, "second candidate"...)
				peers = append(peers, proxyTestSOCKSPeer(t, 35, reply, false))
			}
			var proxyDials int
			connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
				proxyDials++
				if proxyDials > len(peers) {
					return nil, errors.New("unexpected proxy dial")
				}
				return proxyTestDial(peers[proxyDials-1], cfg.endpoint)(ctx, network, address)
			})
			dialer, direct := proxyTestByName(t, connect)
			conn, err := dialer.DialHost(context.Background(), proxyTestTarget(proxyTestFirstIP))
			if tc.retry {
				if err != nil {
					t.Fatal(err)
				}
				requireProxyBytes(t, conn, "second candidate")
				_ = conn.Close()
			} else {
				requireProxyFailure(t, conn, err, proxyHandshakeFailed)
				if errors.Is(err, errProxyCandidate) {
					t.Fatal("terminal reply was treated as retryable")
				}
			}
			if proxyDials != len(peers) || *direct != 0 {
				t.Fatalf("proxy dials=%d, direct dials=%d", proxyDials, *direct)
			}
			for _, peer := range peers {
				peer.check(t)
			}
		})
	}
}

func TestProxyConnector_StopBetweenCandidates(t *testing.T) {
	for _, expire := range []bool{false, true} {
		name := "caller-cancel"
		if expire {
			name = "setup-deadline"
		}
		t.Run(name, func(t *testing.T) {
			cfg := proxyTestConfig("socks5")
			peer := proxyTestSOCKSPeer(t, 34, []byte{5, 4, 0, 1, 0, 0, 0, 0, 0, 0}, false)
			var dials int
			connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
				dials++
				return proxyTestDial(peer, cfg.endpoint)(ctx, network, address)
			})
			caller, stop := context.WithCancel(context.Background())
			defer stop()
			var want error = context.Canceled
			if expire {
				var cancel context.CancelFunc
				caller, cancel = context.WithTimeout(caller, 500*time.Millisecond)
				defer cancel()
				want = proxyTimeout
			}
			dialer, direct := proxyTestByName(t, func(attempt context.Context, target egressTarget) (net.Conn, error) {
				conn, err := connect(attempt, target)
				if errors.Is(err, errProxyCandidate) {
					if !expire {
						stop()
					}
					<-caller.Done()
				}
				return conn, err
			})
			conn, err := dialer.DialHost(caller, proxyTestTarget(proxyTestFirstIP))
			requireProxyFailure(t, conn, err, want)
			if dials != 1 || *direct != 0 {
				t.Fatalf("proxy dials=%d, direct dials=%d", dials, *direct)
			}
			peer.check(t)
		})
	}
}
