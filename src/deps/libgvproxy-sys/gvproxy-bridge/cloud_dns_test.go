package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/miekg/dns"
)

func TestCloudDNSRequiresValidEndpointsBeforeNetworkConstruction(t *testing.T) {
	cfg := testGvproxyConfig()
	var err error
	cfg.guard, err = compilePlatformGuard(nil, true, cfg.Subnet)
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoints := range [][]string{
		nil, {"resolver.example:53"}, {"192.0.2.53"}, {"192.0.2.53:0"},
		{"0.0.0.0:53"}, {"[2001:db8::53]:53"}, {"224.0.0.1:53"},
	} {
		cfg.cloudInventoryDirectory = t.TempDir()
		writeCloudInventory(t, cfg.cloudInventoryDirectory, testCloudInventory(endpoints))
		network, policy, err := newGvproxyNetwork(t.Context(), buildTapConfig(cfg, types.QemuProtocol),
			cfg, nil, nil, outboundPolicy{Mode: "enabled"})
		if err == nil || !strings.Contains(err.Error(), "Cloud DNS") || network != nil || policy != nil {
			t.Fatalf("Cloud startup with %v returned network=%v policy=%v err=%v", endpoints, network, policy, err)
		}
	}
}

func TestCloudDNSGuestServiceAndForwarding(t *testing.T) {
	const name = "api.example.net."
	const public = "203.0.113.44"
	for _, transport := range []string{"udp", "tcp"} {
		t.Run(transport, func(t *testing.T) {
			var approvedUDP, approvedTCP, unapprovedQueries atomic.Int32
			approved, stopResolver := startTestCloudResolver(t, func(network string, q *dns.Msg) *dns.Msg {
				reply := new(dns.Msg).SetReply(q)
				if network == "udp" {
					approvedUDP.Add(1)
					reply.Truncated = true
					return reply
				}
				approvedTCP.Add(1)
				switch q.Question[0].Qtype {
				case dns.TypeA:
					reply.Answer = []dns.RR{
						testRR(t, name+" 60 IN CNAME canonical.example.net."),
						testRR(t, "unrelated.example.net. 60 IN A 203.0.113.30"),
						testRR(t, "canonical.example.net. 60 IN A 192.0.2.8"),
						testRR(t, "canonical.example.net. 60 IN A "+public),
					}
				case dns.TypeTXT:
					reply.Answer = []dns.RR{testRR(t, name+" 60 IN TXT \"approved\"")}
				}
				return reply
			})
			unapproved, _ := startTestCloudResolver(t, func(_ string, q *dns.Msg) *dns.Msg {
				unapprovedQueries.Add(1)
				return new(dns.Msg).SetRcode(q, dns.RcodeServerFailure)
			})
			// Make a misplaced fallback in the outbound path observable at a
			// second real resolver while leaving the guest OS fallback intact.
			endpoints, err := guardinventory.ResolverEndpoints([]string{unapproved})
			if err != nil {
				t.Fatal(err)
			}
			before := systemResolve
			systemResolve = (&cloudDNSResolver{endpoints: endpoints}).lookupHost
			t.Cleanup(func() { systemResolve = before })
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(w, r.Body)
			}))
			t.Cleanup(server.Close)
			cfg := udpServiceConfig()
			cfg.AllowNet = []string{strings.TrimSuffix(name, "."), "localhost"}
			cfg.PlatformProtectedCIDRs = []string{"192.0.2.0/24"}
			cfg.cloudInventoryDirectory = t.TempDir()
			writeCloudInventory(t, cfg.cloudInventoryDirectory, testCloudInventory([]string{approved}))
			attempts := make(chan netip.Addr, 2)
			connect := func(ctx context.Context, target egressTarget) (net.Conn, error) {
				attempts <- target.ConnectionIP
				return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
			}
			tap := startNetworkWithSeams(t, cfg, networkSeams{
				cloud: true, connect: connect,
			})
			var dial guestDialer
			if transport == "tcp" {
				dial = startGuestStack(t, tap, cfg)
			}
			query := func(name string, qtype uint16) *dns.Msg {
				return testGuestDNS(t, tap, cfg.GatewayIP, dial, name, qtype)
			}
			local := query("node.example.", dns.TypeA)
			if len(local.Answer) != 1 || local.Answer[0].(*dns.A).A.String() != "192.0.2.31" ||
				approvedUDP.Load() != 0 || approvedTCP.Load() != 0 {
				t.Fatalf("unexpected local-zone response or upstream traffic: %v", local)
			}
			reply := query(name, dns.TypeTXT)
			if reply.Rcode != dns.RcodeSuccess || len(reply.Answer) != 1 || reply.Answer[0].(*dns.TXT).Txt[0] != "approved" {
				t.Fatalf("unexpected upstream TXT reply: %v", reply)
			}

			if transport == "tcp" {
				request := fmt.Sprintf("POST / HTTP/1.0\r\nHost: %s\r\nContent-Length: 5\r\n\r\nhello", strings.TrimSuffix(name, "."))
				body, err := extendedGuestHTTP(dial, 80, request)
				if err != nil || body != "hello" || len(attempts) != 1 {
					t.Fatalf("hostname forwarding returned body=%q err=%v, dials=%d", body, err, len(attempts))
				}
				if got := <-attempts; got != netip.MustParseAddr(public) {
					t.Fatalf("hostname forwarding selected %s, want %s", got, public)
				}

				replacePolicy(t, tap, `{"mode":"enabled","allow_net":["api.example.net","localhost"]}`, http.StatusOK)
				// Keep the new snapshot's production resolver and route only
				// its final approved connection to the local test listener.
				current := *tap.policy.active.Load()
				dialer := *current.dialer
				dialer.connect = connect
				current.dialer = &dialer
				tap.policy.publish(&current, "confirmed")
				body, err = extendedGuestHTTP(dial, 80, request)
				if err != nil || body != "hello" || len(attempts) != 1 || <-attempts != netip.MustParseAddr(public) {
					t.Fatalf("hostname forwarding after replacement returned body=%q err=%v", body, err)
				}
			}
			wantQueries := int32(1)
			if transport == "tcp" {
				wantQueries = 3
			}
			if approvedUDP.Load() != wantQueries || approvedTCP.Load() != wantQueries {
				t.Fatalf("approved resolver received UDP=%d TCP=%d, want %d of each", approvedUDP.Load(), approvedTCP.Load(), wantQueries)
			}
			stopResolver()
			// A system lookup would answer localhost even without an upstream DNS server.
			outage := query("localhost.", dns.TypeA)
			if outage.Rcode != dns.RcodeServerFailure || len(outage.Answer) != 0 {
				t.Fatalf("resolver outage produced a fallback answer: %v", outage)
			}
			if transport == "tcp" {
				if _, err := extendedGuestHTTP(dial, 80, "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n"); err == nil || len(attempts) != 0 {
					t.Fatalf("hostname forwarding used fallback: err=%v, dials=%d", err, len(attempts))
				}
			}
			if got := unapprovedQueries.Load(); got != 0 {
				t.Fatalf("unapproved resolver received %d queries", got)
			}
		})
	}
}

func TestCloudDNSRetriesConfiguredEndpointsAndCancelsLookup(t *testing.T) {
	silent := make(chan struct{})
	entered := make(chan struct{}, 1)
	first, _ := startTestCloudResolver(t, func(_ string, q *dns.Msg) *dns.Msg {
		if q.Question[0].Name == "cancel.example.net." {
			entered <- struct{}{}
			<-silent
		}
		return new(dns.Msg).SetRcode(q, dns.RcodeServerFailure)
	})
	t.Cleanup(func() { close(silent) })
	var retries atomic.Int32
	answer := testRR(t, "retry.example.net. 30 IN A 203.0.113.23")
	second, _ := startTestCloudResolver(t, func(_ string, q *dns.Msg) *dns.Msg {
		retries.Add(1)
		reply := new(dns.Msg).SetReply(q)
		reply.Answer = []dns.RR{answer}
		return reply
	})
	host, port, err := net.SplitHostPort(second)
	if err != nil {
		t.Fatal(err)
	}
	endpoints, err := guardinventory.ResolverEndpoints([]string{first, net.JoinHostPort("::ffff:"+host, port)})
	if err != nil {
		t.Fatal(err)
	}
	resolver := &cloudDNSResolver{endpoints: endpoints}
	ips, err := resolver.lookupHost(t.Context(), "retry.example.net")
	if err != nil || len(ips) != 1 || ips[0].String() != "203.0.113.23" || retries.Load() != 1 {
		t.Fatalf("approved retry: addresses=%v retries=%d err=%v", ips, retries.Load(), err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := resolver.lookupHost(ctx, "cancel.example.net")
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(forwardWindow):
		t.Fatal("the first resolver did not receive the query")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || retries.Load() != 1 {
			t.Fatalf("canceled lookup: retries=%d err=%v", retries.Load(), err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt the pending DNS exchange")
	}
}

func startTestCloudResolver(t *testing.T, reply func(string, *dns.Msg) *dns.Msg) (string, func()) {
	t.Helper()
	tcp, port := listenTCP(t)
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(port)})
	if err != nil {
		t.Fatal(err)
	}
	readyUDP, readyTCP := make(chan struct{}), make(chan struct{})
	handler := func(network string) dns.Handler {
		return dns.HandlerFunc(func(w dns.ResponseWriter, request *dns.Msg) {
			_ = w.WriteMsg(reply(network, request))
		})
	}
	udpServer := &dns.Server{PacketConn: udp, Handler: handler("udp"), NotifyStartedFunc: func() { close(readyUDP) }}
	tcpServer := &dns.Server{Listener: tcp, Handler: handler("tcp"), NotifyStartedFunc: func() { close(readyTCP) }}
	for _, server := range []*dns.Server{udpServer, tcpServer} {
		go func() {
			if err := server.ActivateAndServe(); err != nil {
				t.Error(err)
			}
		}()
	}
	for _, ready := range []chan struct{}{readyUDP, readyTCP} {
		select {
		case <-ready:
		case <-time.After(forwardWindow):
			t.Fatal("test resolver did not start")
		}
	}
	stop := sync.OnceFunc(func() {
		ctx, cancel := context.WithTimeout(context.Background(), forwardWindow)
		defer cancel()
		if err := udpServer.ShutdownContext(ctx); err != nil {
			t.Error(err)
		}
		if err := tcpServer.ShutdownContext(ctx); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(stop)
	return tcp.Addr().String(), stop
}

func testGuestDNS(t *testing.T, tap *guestTap, gateway string, dial guestDialer, name string, qtype uint16) *dns.Msg {
	t.Helper()
	request := new(dns.Msg).SetQuestion(name, qtype)
	if dial != nil {
		conn, err := dial(gateway, 53)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		client := dns.Client{Net: "tcp", Timeout: 5 * time.Second}
		response, _, err := client.ExchangeWithConnContext(t.Context(), request, &dns.Conn{Conn: conn})
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	wire, err := request.Pack()
	if err != nil {
		t.Fatal(err)
	}
	tap.send(t, udpFrame(t, gateway, 53, wire))
	response := new(dns.Msg)
	if err := response.Unpack(readGuestUDP(t, tap, gateway, 53, guestSrcPort)); err != nil {
		t.Fatal(err)
	}
	if !response.Response || response.Id != request.Id {
		t.Fatalf("unexpected DNS response: %v", response)
	}
	return response
}

func testRR(t *testing.T, record string) dns.RR {
	t.Helper()
	rr, err := dns.NewRR(record)
	if err != nil {
		t.Error(err)
	}
	return rr
}
