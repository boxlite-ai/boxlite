package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

type connectionExample struct {
	ID             string `json:"id"`
	Hostname       string `json:"hostname"`
	PolicyIP       string `json:"policy_ip"`
	ConnectionIP   string `json:"connection_ip"`
	Port           uint16 `json:"port"`
	Protocol       string `json:"protocol"`
	PolicyRevision string `json:"policy_revision"`
}

func (e connectionExample) target() egressTarget {
	return egressTarget{Hostname: e.Hostname, PolicyIP: netip.MustParseAddr(e.PolicyIP),
		ConnectionIP: netip.MustParseAddr(e.ConnectionIP), Port: e.Port, Protocol: e.Protocol, PolicyRevision: e.PolicyRevision}
}

func connectionExamples(t *testing.T) []connectionExample {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "outbound", "contract-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []connectionExample `json:"connection_cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) != 2 {
		t.Fatal("expected NAT and hostname connection examples")
	}
	return fixture.Cases
}

func transportTLSServer(t *testing.T, ca *BoxCA, hostname string, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	cert, err := ca.GenerateHostCert(hostname)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{*cert}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func guestTransportRequest(t *testing.T, dial guestDialer, target egressTarget, tlsConfig *tls.Config, authorization string) (int, string) {
	t.Helper()
	conn, err := dial(target.PolicyIP.String(), target.Port)
	if err != nil {
		t.Fatalf("guest dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if tlsConfig != nil {
		client := tls.Client(conn, tlsConfig)
		if err := client.Handshake(); err != nil {
			t.Fatalf("guest TLS: %v", err)
		}
		conn = client
	}
	host := target.Hostname
	if host == "" {
		host = target.PolicyIP.String()
	}
	if _, err := fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nAuthorization: %s\r\nConnection: close\r\n\r\n", host, authorization); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(body)
}

func TestEgressTransport_GuestConnectionContract(t *testing.T) {
	for _, example := range connectionExamples(t) {
		modes := []string{"restricted"}
		if example.Hostname == "" {
			modes = append(modes, "unrestricted")
		}
		for _, mode := range modes {
			t.Run(example.ID+"/"+mode, func(t *testing.T) {
				ca := newTestCA(t)
				handler := func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "selected transport") }
				var server *httptest.Server
				var tlsConfig *tls.Config
				if example.Hostname == "" {
					server = httptest.NewServer(http.HandlerFunc(handler))
					t.Cleanup(server.Close)
				} else {
					server = transportTLSServer(t, ca, example.Hostname, handler)
					pool, _ := ca.CACertPool()
					tlsConfig = &tls.Config{RootCAs: pool, ServerName: example.Hostname}
				}
				targets := make(chan egressTarget, 1)
				cfg := testGvproxyConfig()
				if mode == "restricted" {
					rule := example.PolicyIP
					if example.Hostname != "" {
						rule = example.Hostname
					}
					cfg.AllowNet = []string{rule}
				}
				tap := startNetworkWithSeams(t, cfg, networkSeams{
					resolve: staticResolve(example.ConnectionIP), dial: refuseDial,
					connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
						targets <- target
						return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
					},
				})
				want := example.target()
				status, body := guestTransportRequest(t, startGuestStack(t, tap, cfg), want, tlsConfig, "")
				if status != http.StatusOK || body != "selected transport" {
					t.Fatalf("guest response: %d %q", status, body)
				}
				select {
				case got := <-targets:
					if got != want {
						t.Fatalf("transport target: got %+v, want %+v", got, want)
					}
				default:
					t.Fatal("guest traffic bypassed the selected transport")
				}
			})
		}
	}
}

func TestEgressTransport_DeniedGuestNeverConnects(t *testing.T) {
	for _, tc := range []struct {
		name, address, hostname, resolved string
		port                              uint16
	}{
		{name: "address", address: "192.0.2.99", port: 8080},
		{name: "link-local", address: "169.254.169.254", port: 80},
		{name: "hostname", address: "192.0.2.99", hostname: "blocked.example.com", port: 443},
		{name: "resolved-private", address: "192.0.2.99", hostname: "api.example.com", resolved: "10.0.0.8", port: 443},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			cfg := testGvproxyConfig()
			cfg.AllowNet = []string{"api.example.com"}
			tap := startNetworkWithSeams(t, cfg, networkSeams{
				resolve: staticResolve(tc.resolved), dial: refuseDial,
				connect: func(context.Context, egressTarget) (net.Conn, error) {
					calls.Add(1)
					return nil, errors.New("unexpected selected transport call")
				},
			})
			conn, err := startGuestStack(t, tap, cfg)(tc.address, tc.port)
			if tc.hostname != "" && err == nil {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				err = tls.Client(conn, &tls.Config{ServerName: tc.hostname}).Handshake()
			}
			if err == nil {
				_ = conn.Close()
				t.Fatal("denied guest connection succeeded")
			}
			if got := calls.Load(); got != 0 {
				t.Fatalf("denied target reached selected transport %d times", got)
			}
		})
	}
}

func TestEgressTransport_GuestFailureDoesNotFallback(t *testing.T) {
	var selected, direct atomic.Int32
	cfg := testGvproxyConfig()
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		connect: func(context.Context, egressTarget) (net.Conn, error) {
			selected.Add(1)
			return nil, errors.New("selected transport unavailable")
		},
		dial: func(context.Context, string, string) (net.Conn, error) {
			direct.Add(1)
			return nil, errors.New("unexpected direct fallback")
		},
	})
	// Send exactly one SYN. A TCP client may retransmit before receiving the
	// rejection under instrumentation, which creates another forwarding attempt.
	tap.send(t, tcpSynFrame(t, cfg.HostIP, 8080))
	select {
	case frame := <-tap.frames:
		if len(frame) < header.EthernetMinimumSize+header.IPv4MinimumSize+header.TCPMinimumSize {
			t.Fatalf("truncated rejection frame: %x", frame)
		}
		ip := header.IPv4(frame[header.EthernetMinimumSize:])
		if ip.Protocol() != uint8(tcp.ProtocolNumber) || int(ip.HeaderLength())+header.TCPMinimumSize > len(ip) {
			t.Fatalf("expected a TCP rejection: %x", frame)
		}
		reply := header.TCP(ip[ip.HeaderLength():])
		if reply.Flags()&header.TCPFlagRst == 0 || reply.DestinationPort() != guestSrcPort || reply.AckNumber() != 1001 {
			t.Fatalf("expected reset acknowledging the failed SYN: %x", frame)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("selected transport failure did not reject the guest SYN")
	}
	if selected.Load() != 1 || direct.Load() != 0 {
		t.Fatalf("selected=%d direct=%d", selected.Load(), direct.Load())
	}
}

func TestEgressTransport_AddressSetupIsBoundedAndCancelable(t *testing.T) {
	d, _ := newTestEgressDialer(t, nil, refuseResolve)
	entered := make(chan time.Time, 1)
	d.connect = func(ctx context.Context, _ egressTarget) (net.Conn, error) {
		deadline, _ := ctx.Deadline()
		entered <- deadline
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := d.byAddress(egressTarget{ConnectionIP: netip.MustParseAddr("192.0.2.8"), Port: 443})(ctx)
		done <- err
	}()
	select {
	case deadline := <-entered:
		if deadline.IsZero() || time.Until(deadline) > upstreamDialTimeout {
			t.Fatalf("selected transport lacks the setup deadline: %v", deadline)
		}
	case <-time.After(time.Second):
		t.Fatal("selected transport was not entered")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("setup cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled setup did not release the transport")
	}
}

func TestEgressTransport_GuestMITM(t *testing.T) {
	// Production uses system roots. A child installs a test root without
	// weakening TLS verification or changing the other tests' global roots.
	if os.Getenv("BOXLITE_TEST_EGRESS_MITM") != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestEgressTransport_GuestMITM$", "-test.count=1", "-test.v")
		command.Env = append(os.Environ(), "BOXLITE_TEST_EGRESS_MITM=1", "GODEBUG=x509usefallbackroots=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("guest MITM child: %v\n%s", err, output)
		}
		return
	}
	ca := newTestCA(t)
	pool, _ := ca.CACertPool()
	x509.SetFallbackRoots(pool)
	for _, serverName := range []string{"api.example.com", "wrong.example.com"} {
		t.Run(serverName, func(t *testing.T) {
			var requests atomic.Int32
			server := transportTLSServer(t, ca, serverName, func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				_, _ = io.WriteString(w, r.Header.Get("Authorization"))
			})
			want := connectionExamples(t)[1].target()
			targets := make(chan egressTarget, 4)
			cfg := testGvproxyConfig()
			cfg.AllowNet = []string{want.Hostname}
			tap := startNetworkWithSeams(t, cfg, networkSeams{
				ca: ca, secretMatcher: NewSecretHostMatcher(testSecrets()),
				resolve: staticResolve(want.ConnectionIP.String()), dial: refuseDial,
				connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
					targets <- target
					return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
				},
			})
			status, body := guestTransportRequest(t, startGuestStack(t, tap, cfg), want,
				&tls.Config{RootCAs: pool, ServerName: want.Hostname}, "Bearer <BOXLITE_SECRET:k>")
			if serverName == want.Hostname {
				if status != http.StatusOK || body != "Bearer real-value" || requests.Load() != 1 {
					t.Fatalf("MITM response: %d %q requests=%d", status, body, requests.Load())
				}
			} else if status != http.StatusBadGateway || requests.Load() != 0 {
				t.Fatalf("unverified upstream received a request: status=%d requests=%d", status, requests.Load())
			}
			select {
			case got := <-targets:
				if got != want {
					t.Fatalf("MITM target: got %+v, want %+v", got, want)
				}
			default:
				t.Fatal("MITM bypassed selected transport")
			}
		})
	}
}
