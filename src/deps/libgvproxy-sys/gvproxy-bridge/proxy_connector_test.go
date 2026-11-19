package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	logrus "github.com/sirupsen/logrus"
)

var (
	proxyTestEndpoint   = netip.MustParseAddrPort("1.1.1.1:3128")
	proxyTestFirstIP    = netip.MustParseAddr("93.184.216.34")
	proxyTestSecondIP   = netip.MustParseAddr("93.184.216.35")
	proxyTestCredential = proxyCredentials{"fixture-user", "fixture-pass"}
)

const proxyTestTLSName = "proxy.example.net"

type proxyTestPeer struct {
	address string
	done    <-chan error
}

func startProxyTestPeer(t *testing.T, serve func(*net.TCPConn) error) proxyTestPeer {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	done := make(chan error, 1)
	go func() {
		conn, err := listener.AcceptTCP()
		if err == nil {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
			err = serve(conn)
		}
		done <- err
	}()
	return proxyTestPeer{listener.Addr().String(), done}
}

func (p proxyTestPeer) check(t *testing.T) {
	t.Helper()
	select {
	case err := <-p.done:
		if err != nil {
			t.Fatalf("proxy peer: %v", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("proxy peer did not finish")
	}
}

func proxyTestConfig(scheme string) proxyConnectorConfig {
	return proxyConnectorConfig{scheme: scheme, endpoint: proxyTestEndpoint, serverName: proxyTestTLSName}
}

func proxyTestTarget(ip netip.Addr) egressTarget {
	return egressTarget{Hostname: "service.example.net", PolicyIP: proxyTestFirstIP, ConnectionIP: ip, Port: 443}
}

func proxyTestDial(peer proxyTestPeer, endpoint netip.AddrPort) dialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != endpoint.String() {
			return nil, fmt.Errorf("unexpected proxy socket dial %s %s", network, address)
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp4", peer.address)
	}
}

func mustProxyConnector(t *testing.T, cfg proxyConnectorConfig, dial dialFunc) connectFunc {
	t.Helper()
	connect, err := newProxyConnector(cfg, dial)
	if err != nil {
		t.Fatal(err)
	}
	return connect
}

func proxyTestTLS(t *testing.T, ca *BoxCA, name string) (*tls.Config, *x509.CertPool) {
	t.Helper()
	cert, err := ca.GenerateHostCert(name)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := ca.CACertPool()
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{*cert}}, pool
}

func readTestProxyCONNECT(conn io.Reader, authority, auth string) error {
	request, err := http.ReadRequest(bufio.NewReader(conn))
	if err != nil {
		return err
	}
	if request.Method != "CONNECT" || request.RequestURI != authority || request.Host != authority {
		return fmt.Errorf("unexpected CONNECT request: %s %s, host %s", request.Method, request.RequestURI, request.Host)
	}
	if request.Header.Get("Proxy-Authorization") != auth {
		return errors.New("unexpected Proxy-Authorization value")
	}
	return nil
}

func requireProxyFailure(t *testing.T, conn net.Conn, err, want error) {
	t.Helper()
	if conn != nil {
		_ = conn.Close()
		t.Fatal("failed proxy setup returned a tunnel")
	}
	if !errors.Is(err, want) {
		t.Fatalf("got %v, want %v", err, want)
	}
}

func requirePeerClose(conn io.Reader) error {
	var extra [1]byte
	n, err := conn.Read(extra[:])
	closed := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET)
	if n != 0 || !closed {
		return fmt.Errorf("expected peer closure with no extra bytes, got %d bytes, %v", n, err)
	}
	return nil
}

func requireProxyBytes(t *testing.T, conn net.Conn, want string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, len(want))
	if _, err := io.ReadFull(conn, got); err != nil || string(got) != want {
		t.Fatalf("tunnel bytes %q, %v, want %q", got, err, want)
	}
}

func TestProxyConnector_HTTP(t *testing.T) {
	tlsConfig, roots := proxyTestTLS(t, newTestCA(t), proxyTestTLSName)
	for _, scheme := range []string{"http", "https"} {
		for _, response := range []struct {
			name, header string
			want         error
		}{
			{"plain", "HTTP/1.1 200 OK\r\n\r\n", nil},
			{"conflicting-lengths", "HTTP/1.1 201 Open\r\nContent-Length: 1\r\nContent-Length: 10000\r\n\r\n", nil},
			{"chunked", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", nil},
			{"header-limit", proxyInterimResponse(12*1024) + proxyInterimResponse(12*1024) + proxyFinalResponse(12*1024), proxyHandshakeFailed},
			{"unauthorized", "HTTP/1.1 407 Authentication Required\r\n\r\n", proxyAuthFailed},
			{"redirect", "HTTP/1.1 302 Found\r\nLocation: https://proxy.example.org/\r\n\r\n", proxyHandshakeFailed},
			{"upstream-error", "HTTP/1.1 502 Bad Gateway\r\n\r\n", proxyHandshakeFailed},
		} {
			t.Run(scheme+"/"+response.name, func(t *testing.T) {
				cfg := proxyTestConfig(scheme)
				cfg.roots = roots
				var auth string
				if response.name != "plain" {
					cfg.credential = &proxyTestCredential
					auth = "Basic " + base64.StdEncoding.EncodeToString([]byte("fixture-user:fixture-pass"))
				}
				const early = "raw tunnel prefix"
				peer := startProxyTestPeer(t, func(raw *net.TCPConn) error {
					var conn net.Conn = raw
					if scheme == "https" {
						conn = tls.Server(raw, tlsConfig)
					}
					if err := readTestProxyCONNECT(conn, "93.184.216.34:443", auth); err != nil {
						return err
					}
					if _, err := io.WriteString(conn, response.header+early); err != nil {
						return err
					}
					return requirePeerClose(conn)
				})
				var proxyDials int
				dial := proxyTestDial(peer, cfg.endpoint)
				connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
					proxyDials++
					return dial(ctx, network, address)
				})
				dialer, direct := proxyTestByName(t, connect)
				ctx, cancel := context.WithCancel(context.Background())
				conn, err := dialer.DialHost(ctx, proxyTestTarget(proxyTestFirstIP))
				cancel()
				if response.want != nil {
					requireProxyFailure(t, conn, err, response.want)
				} else {
					if err != nil {
						t.Fatal(err)
					}
					defer conn.Close()
					requireProxyBytes(t, conn, early)
					_ = conn.Close()
				}
				peer.check(t)
				if proxyDials != 1 || *direct != 0 {
					t.Fatalf("proxy dials=%d, direct dials=%d", proxyDials, *direct)
				}
			})
		}
	}
}

func proxyInterimResponse(size int) string {
	line := "HTTP/1.1 103 Early Hints\r\nX-Padding: "
	return line + strings.Repeat("x", size-len(line)-4) + "\r\n\r\n"
}

func proxyFinalResponse(size int) string {
	line := "HTTP/1.1 200 OK\r\nX-Padding: "
	return line + strings.Repeat("x", size-len(line)-4) + "\r\n\r\n"
}

func TestProxyConnector_TLSVerification(t *testing.T) {
	trusted := newTestCA(t)
	for _, tc := range []struct {
		name, certificateName string
		issuer                *BoxCA
	}{
		{"wrong-name", "other.example.net", trusted},
		{"untrusted-issuer", proxyTestTLSName, newTestCA(t)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tlsConfig, _ := proxyTestTLS(t, tc.issuer, tc.certificateName)
			cfg := proxyTestConfig("https")
			cfg.roots, _ = trusted.CACertPool()
			cfg.credential = &proxyTestCredential
			peer := startProxyTestPeer(t, func(raw *net.TCPConn) error {
				if err := tls.Server(raw, tlsConfig).Handshake(); err == nil {
					return errors.New("proxy TLS unexpectedly completed")
				}
				return nil
			})
			var proxyDials int
			dial := proxyTestDial(peer, cfg.endpoint)
			connect := mustProxyConnector(t, cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
				proxyDials++
				return dial(ctx, network, address)
			})
			dialer, direct := proxyTestByName(t, connect)
			conn, err := dialer.DialHost(context.Background(), proxyTestTarget(proxyTestFirstIP))
			requireProxyFailure(t, conn, err, proxyHandshakeFailed)
			peer.check(t)
			if proxyDials != 1 || *direct != 0 {
				t.Fatalf("proxy dials=%d, direct dials=%d", proxyDials, *direct)
			}
		})
	}
}

func TestProxyConnector_GuestLogsRedactProxyFailure(t *testing.T) {
	capture := captureLogs(t)
	logrus.SetLevel(logrus.TraceLevel)
	cfg := proxyTestConfig("http")
	cfg.credential = &proxyTestCredential
	encoded := base64.StdEncoding.EncodeToString([]byte("fixture-user:fixture-pass"))
	const peerReason = "fixture-private-peer-reason"
	peer := startProxyTestPeer(t, func(conn *net.TCPConn) error {
		if err := readTestProxyCONNECT(conn, "93.184.216.34:443", "Basic "+encoded); err != nil {
			return err
		}
		if _, err := io.WriteString(conn, "HTTP/1.1 407 "+peerReason+"\r\nX-Fixture: "+encoded+"\r\n\r\n"); err != nil {
			return err
		}
		return requirePeerClose(conn)
	})
	connect := mustProxyConnector(t, cfg, proxyTestDial(peer, cfg.endpoint))
	outcome := make(chan error, 1)
	var direct atomic.Int32
	guestConfig := testGvproxyConfig()
	guestConfig.AllowNet = []string{proxyTestFirstIP.String()}
	tap := startNetworkWithSeams(t, guestConfig, networkSeams{
		connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
			conn, err := connect(ctx, target)
			select {
			case outcome <- err:
			default:
			}
			return conn, err
		},
		dial: func(context.Context, string, string) (net.Conn, error) {
			direct.Add(1)
			return nil, errors.New("unexpected direct dial")
		},
	})
	guest, err := startGuestStack(t, tap, guestConfig)(proxyTestFirstIP.String(), 443)
	if err == nil {
		_ = guest.Close()
		t.Fatal("guest connected through a rejected proxy")
	}
	select {
	case err = <-outcome:
		if !errors.Is(err, proxyAuthFailed) {
			t.Fatalf("unexpected connector diagnostic: %v", err)
		}
	default:
		t.Fatal("guest traffic never reached the connector")
	}
	peer.check(t)
	if direct.Load() != 0 {
		t.Fatal("proxy failure fell back to a direct dial")
	}

	loggedFailure := false
	observed := err.Error()
	capture.mu.Lock()
	for _, entry := range capture.entries {
		loggedFailure = loggedFailure || entry.Message == "outbound dial = proxy_auth_failed"
		observed += fmt.Sprint(entry.Message, entry.Data)
	}
	capture.mu.Unlock()
	if !loggedFailure {
		t.Fatal("forwarder did not log the redacted proxy diagnostic")
	}
	for _, marker := range []string{peerReason, "fixture-user", "fixture-pass", encoded} {
		if strings.Contains(observed, marker) {
			t.Fatal("proxy error or forwarder log exposed peer text or credentials")
		}
	}
}

func readProxyTestBytes(conn io.Reader, want []byte) error {
	got := make([]byte, len(want))
	if _, err := io.ReadFull(conn, got); err != nil {
		return err
	}
	if !bytes.Equal(got, want) {
		return errors.New("unexpected SOCKS5 bytes")
	}
	return nil
}

func TestProxyConnector_SOCKS5(t *testing.T) {
	for _, tc := range []struct {
		name          string
		password      bool
		selection     []byte
		passwordReply []byte
		proxyReply    []byte
		want          error
	}{
		{"no-auth", false, []byte{5, 0}, nil, []byte{5, 0, 0, 3, 3, 'l', 'a', 'n', 0, 0}, nil},
		{"password", true, []byte{5, 2}, []byte{1, 0}, []byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}, nil},
		{"downgrade", true, []byte{5, 0}, nil, nil, proxyAuthFailed},
		{"wrong-selection-version", true, []byte{4, 2}, nil, nil, proxyHandshakeFailed},
		{"wrong-password-version", true, []byte{5, 2}, []byte{5, 0}, nil, proxyHandshakeFailed},
		{"bad-password", true, []byte{5, 2}, []byte{1, 1}, nil, proxyAuthFailed},
		{"ruleset-refusal", false, []byte{5, 0}, nil, []byte{5, 2, 0, 1, 0, 0, 0, 0, 0, 0}, proxyHandshakeFailed},
		{"wrong-reply-version", false, []byte{5, 0}, nil, []byte{4, 0, 0, 1, 0, 0, 0, 0, 0, 0}, proxyHandshakeFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := proxyTestConfig("socks5")
			method := byte(0)
			if tc.password {
				method = 2
				cfg.credential = &proxyTestCredential
			}
			const early = "socks target payload"
			peer := startProxyTestPeer(t, func(conn *net.TCPConn) error {
				if err := readProxyTestBytes(conn, []byte{5, 1, method}); err != nil {
					return err
				}
				if _, err := conn.Write(tc.selection); err != nil {
					return err
				}
				if tc.passwordReply != nil {
					auth := append([]byte{1, 12}, "fixture-user"...)
					auth = append(auth, 12)
					auth = append(auth, "fixture-pass"...)
					if err := readProxyTestBytes(conn, auth); err != nil {
						return err
					}
					if _, err := conn.Write(tc.passwordReply); err != nil {
						return err
					}
				}
				if tc.proxyReply != nil {
					if err := readProxyTestBytes(conn, []byte{5, 1, 0, 1, 93, 184, 216, 34, 1, 187}); err != nil {
						return err
					}
					reply := append([]byte(nil), tc.proxyReply...)
					if tc.want == nil {
						reply = append(reply, early...)
					}
					if _, err := conn.Write(reply); err != nil {
						return err
					}
				}
				return requirePeerClose(conn)
			})
			connect := mustProxyConnector(t, cfg, proxyTestDial(peer, cfg.endpoint))
			ctx, cancel := context.WithCancel(context.Background())
			conn, err := connect(ctx, proxyTestTarget(proxyTestFirstIP))
			cancel()
			if tc.want != nil {
				requireProxyFailure(t, conn, err, tc.want)
			} else {
				if err != nil {
					t.Fatal(err)
				}
				defer conn.Close()
				requireProxyBytes(t, conn, early)
				_ = conn.Close()
			}
			peer.check(t)
		})
	}
}
