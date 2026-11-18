package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
)

func TestExtendedTCPFragmentedTLSOnUnusualPort(t *testing.T) {
	const host, approvedIP = "api.example.com", "203.0.113.8"
	const port = 8443
	ca := newTestCA(t)
	pool, err := ca.CACertPool()
	if err != nil {
		t.Fatal(err)
	}
	server := transportTLSServer(t, ca, host, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "fragmented ClientHello relayed")
	})
	cfg := testGvproxyConfig()
	targets := make(chan egressTarget, 2)
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		tcp:     &trustedTCPRules{allow: []string{host + ":8443"}},
		resolve: staticResolve(approvedIP),
		dial:    refuseDial,
		connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
			targets <- target
			return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
		},
	})
	conn, err := startGuestStack(t, tap, cfg)(unlistedIP, port)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	fragmented := &fragmentClientHello{Conn: conn}
	client := tls.Client(fragmented, &tls.Config{RootCAs: pool, ServerName: host})
	if _, err := io.WriteString(client, "GET / HTTP/1.1\r\nHost: "+host+"\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(client), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "fragmented ClientHello relayed" || !fragmented.sent {
		t.Fatalf("TLS relay: body=%q err=%v fragmented=%t", body, err, fragmented.sent)
	}
	select {
	case got := <-targets:
		if got.Hostname != host || got.Port != port || got.ConnectionIP.String() != approvedIP {
			t.Fatalf("wrong TLS target: %+v", got)
		}
	default:
		t.Fatal("TLS relay bypassed connector")
	}
}

type fragmentClientHello struct {
	net.Conn
	sent bool
}

func TestExtendedTCPMITMUpgradeClosesListener(t *testing.T) {
	const host, message = "api.example.com", "test upgrade traffic"
	ca := newTestCA(t)
	pool, err := ca.CACertPool()
	if err != nil {
		t.Fatal(err)
	}
	server := transportTLSServer(t, ca, host, func(w http.ResponseWriter, _ *http.Request) {
		conn, buf, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		if _, err := buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test-echo\r\n\r\n"); err != nil {
			t.Error(err)
			return
		}
		if err := buf.Flush(); err != nil {
			t.Error(err)
			return
		}
		_, _ = io.Copy(conn, buf)
	})
	guestSide, proxySide := net.Pipe()
	defer guestSide.Close()
	defer proxySide.Close()
	_ = guestSide.SetDeadline(time.Now().Add(5 * time.Second))
	setup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		mitmForward(proxySide, host, dialTo(server.Listener.Addr().String()), ca, nil, setup,
			&tls.Config{RootCAs: pool, ServerName: host})
	}()
	client := tls.Client(guestSide, &tls.Config{RootCAs: pool, ServerName: host})
	request := "GET / HTTP/1.1\r\nHost: " + host + "\r\nConnection: Upgrade\r\nUpgrade: test-echo\r\n\r\n"
	if _, err := io.WriteString(client, request); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(client)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("MITM upgrade: response=%v err=%v", response, err)
	}
	response.Body.Close()
	if _, err := io.WriteString(client, message); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, len(message))
	if _, err := io.ReadFull(reader, echo); err != nil || string(echo) != message {
		t.Fatalf("upgraded traffic: got %q err=%v", echo, err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("MITM listener remained open after the upgraded connection closed")
	}
}

func (c *fragmentClientHello) Write(wire []byte) (int, error) {
	if c.sent {
		return c.Conn.Write(wire)
	}
	const header, split = 5, 20
	if len(wire) <= header+split || wire[0] != 0x16 || int(binary.BigEndian.Uint16(wire[3:5])) != len(wire)-header {
		return 0, fmt.Errorf("expected one TLS ClientHello record")
	}
	first := append([]byte{}, wire[:header+split]...)
	binary.BigEndian.PutUint16(first[3:5], split)
	second := append(append([]byte{}, wire[:header]...), wire[header+split:]...)
	binary.BigEndian.PutUint16(second[3:5], uint16(len(second)-header))
	for _, record := range [][]byte{first, second} {
		if _, err := c.Conn.Write(record); err != nil {
			return 0, err
		}
	}
	c.sent = true
	return len(wire), nil
}

func TestExtendedTCPMITM(t *testing.T) {
	if os.Getenv("BOXLITE_TEST_EXTENDED_MITM") != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestExtendedTCPMITM$", "-test.count=1", "-test.v")
		command.Env = append(os.Environ(), "BOXLITE_TEST_EXTENDED_MITM=1", "GODEBUG=x509usefallbackroots=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("extended MITM child: %v\n%s", err, output)
		}
		return
	}
	ca := newTestCA(t)
	pool, err := ca.CACertPool()
	if err != nil {
		t.Fatal(err)
	}
	x509.SetFallbackRoots(pool)
	upstreamDialTimeout = 2 * time.Second

	const host = "api.example.com"
	const permitted = "203.0.113.8"
	const refused = "192.0.2.8"
	for _, scenario := range []string{"verified", "redial", "denied-name", "idle-guest", "stalled-upstream", "wrong-upstream-certificate"} {
		t.Run(scenario, func(t *testing.T) {
			cfg := testGvproxyConfig()
			rules := trustedTCPRules{allow: []string{unlistedIP}, deny: []string{"192.0.2.0/24:443"}}
			if scenario == "denied-name" {
				rules.deny = append(rules.deny, host+":443")
			}
			var resolves, connects, requests atomic.Int32
			tlsClosed := make(chan struct{})
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if scenario == "redial" {
					w.Header().Set("Connection", "close")
				}
				if scenario == "verified" && r.ProtoMajor != 2 {
					t.Errorf("upstream protocol = %s, want HTTP/2", r.Proto)
				}
				_, _ = io.WriteString(w, r.Header.Get("Authorization"))
			}))
			serverName := host
			if scenario == "wrong-upstream-certificate" {
				serverName = "wrong.example.com"
			}
			cert, err := ca.GenerateHostCert(serverName)
			if err != nil {
				t.Fatal(err)
			}
			server.EnableHTTP2 = scenario == "verified"
			server.TLS = &tls.Config{Certificates: []tls.Certificate{*cert}}
			server.StartTLS()
			defer server.Close()

			tap := startNetworkWithSeams(t, cfg, networkSeams{
				tcp: &rules, ca: ca, secretMatcher: NewSecretHostMatcher(testSecrets()),
				resolve: func(context.Context, string) ([]net.IP, error) {
					if resolves.Add(1) > 1 && scenario == "redial" {
						return []net.IP{net.ParseIP(refused)}, nil
					}
					return []net.IP{net.ParseIP(permitted)}, nil
				},
				dial: refuseDial,
				connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
					connects.Add(1)
					if target.ConnectionIP != netip.MustParseAddr(permitted) || target.PolicyRevision != cfg.OutboundRevision {
						t.Errorf("unexpected MITM socket: %+v", target)
					}
					if scenario == "stalled-upstream" {
						client, stalled := net.Pipe()
						go func() {
							defer close(tlsClosed)
							defer stalled.Close()
							_, _ = io.Copy(io.Discard, stalled)
						}()
						return client, nil
					}
					return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
				},
			})
			conn, err := startGuestStack(t, tap, cfg)(unlistedIP, 443)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(6 * time.Second))
			guest := tls.Client(conn, &tls.Config{RootCAs: pool, ServerName: host})
			err = guest.Handshake()
			if scenario == "denied-name" {
				if err == nil || resolves.Load() != 0 || connects.Load() != 0 {
					t.Fatalf("denied MITM: err=%v, resolves=%d, connects=%d", err, resolves.Load(), connects.Load())
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "idle-guest" {
				_, err := guest.Read(make([]byte, 1))
				if err == nil || resolves.Load() != 0 || connects.Load() != 0 {
					t.Fatalf("idle MITM: err=%v, resolves=%d, connects=%d", err, resolves.Load(), connects.Load())
				}
				if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
					t.Fatal("guest's deadline fired before MITM closed the idle connection")
				}
				return
			}

			reader := bufio.NewReader(guest)
			request := func() (*http.Response, error) {
				_, err := io.WriteString(guest, "GET / HTTP/1.1\r\nHost: "+host+"\r\nAuthorization: Bearer <BOXLITE_SECRET:k>\r\n\r\n")
				if err != nil {
					return nil, err
				}
				return http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
			}
			response, err := request()
			if scenario == "stalled-upstream" {
				select {
				case <-tlsClosed:
				case <-time.After(4 * time.Second):
					t.Fatal("timed out waiting for stalled upstream socket cleanup")
				}
				if response != nil {
					response.Body.Close()
				}
				if connects.Load() != 1 || requests.Load() != 0 || (err == nil && response.StatusCode == http.StatusOK) {
					t.Fatalf("stalled upstream escaped deadline: err=%v, connects=%d, requests=%d", err, connects.Load(), requests.Load())
				}
				return
			}

			if err != nil {
				t.Fatal(err)
			}
			if scenario == "wrong-upstream-certificate" {
				response.Body.Close()
				if response.StatusCode != http.StatusBadGateway || connects.Load() != 1 || requests.Load() != 0 {
					t.Fatalf("unverified upstream: status=%d connects=%d requests=%d", response.StatusCode, connects.Load(), requests.Load())
				}
				return
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || response.StatusCode != http.StatusOK || string(body) != "Bearer real-value" {
				t.Fatalf("MITM result: status=%d body=%q err=%v", response.StatusCode, body, err)
			}
			if scenario == "redial" {
				if err := tap.policy.replaceTrustedTCP("enabled", trustedTCPRules{deny: []string{host}}, cfg.OutboundRevision, "next"); err != nil {
					t.Fatal(err)
				}
				response, err := request()
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				if response.StatusCode != http.StatusBadGateway || resolves.Load() != 2 {
					t.Fatalf("redial: status=%d resolves=%d", response.StatusCode, resolves.Load())
				}
			}
			if connects.Load() != 1 || requests.Load() != 1 {
				t.Fatalf("MITM deliveries: connects=%d requests=%d", connects.Load(), requests.Load())
			}
		})
	}
}
