package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"
	"gvisor.dev/gvisor/pkg/tcpip/header"
)

type gatewayPipeListener struct {
	incoming chan net.Conn
	closed   chan struct{}
}

func (l gatewayPipeListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.incoming:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l gatewayPipeListener) Close() error { close(l.closed); return nil }
func (gatewayPipeListener) Addr() net.Addr { return &net.TCPAddr{} }

func TestGatewayDNSStalledTCPWritesReleaseSessionSlots(t *testing.T) {
	packet, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener := gatewayPipeListener{incoming: make(chan net.Conn), closed: make(chan struct{})}
	service := serveGatewayDNS(context.Background(), packet, listener, func(_ context.Context, query *dns.Msg) *dns.Msg {
		return new(dns.Msg).SetReply(query)
	}, time.Second)
	defer service.close()
	open := func() *dns.Conn {
		t.Helper()
		client, server := net.Pipe()
		t.Cleanup(func() { _ = client.Close() })
		select {
		case listener.incoming <- server:
		case <-time.After(time.Second):
			_ = server.Close()
			t.Fatal("gateway did not accept a TCP connection")
		}
		return &dns.Conn{Conn: client}
	}
	query := new(dns.Msg).SetQuestion("local.example.net.", dns.TypeA)
	clients := make([]*dns.Conn, 0, gatewayDNSTCPSessions)
	for range gatewayDNSTCPSessions {
		conn := open()
		_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
		if err := conn.WriteMsg(query); err != nil {
			t.Fatalf("fill TCP DNS sessions: %v", err)
		}
		clients = append(clients, conn)
	}
	excess := open()
	_ = excess.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := excess.ReadMsg(); err != io.EOF {
		t.Fatalf("excess DNS session was not closed: %v", err)
	}
	// Wait for the server to reach its write deadlines without allowing any
	// client to read a response. A client that starts reading before then
	// would release the blocked server write instead of proving the deadline.
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		service.mu.Lock()
		remaining := len(service.sessions)
		service.mu.Unlock()
		if remaining == 0 {
			break
		}
		select {
		case <-tick.C:
		case <-timer.C:
			t.Fatalf("%d stalled TCP DNS connections remained open", remaining)
		}
	}
	for _, conn := range clients {
		if _, err := conn.ReadMsg(); err != io.EOF {
			t.Fatalf("stalled client still has readable output: %v", err)
		}
	}
	if reply := gatewayTCPQuery(t, open(), query, forwardWindow); reply.Rcode != dns.RcodeSuccess {
		t.Fatalf("fresh TCP DNS session rejected: %v", reply)
	}
}

func TestGatewayDNSUsesCapturedProxyOnBothPort53Listeners(t *testing.T) {
	resolver, tunnels := startProxyDNSFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := readFixtureDNSRequest(w, r)
		if query == nil {
			return
		}
		reply := new(dns.Msg).SetReply(query)
		if query.Question[0].Qtype == dns.TypeA {
			reply.Answer = []dns.RR{&dns.A{Hdr: fixtureDNSHeader(query.Question[0].Name, dns.TypeA), A: net.IPv4(93, 184, 216, 34)}}
		}
		writeFixtureDNSReply(w, reply)
	}))
	cfg := testGvproxyConfig()
	var gateway *gatewayDNS
	tap := startNetworkWithSeams(t, cfg, networkSeams{beforeAttach: func(ctx context.Context, policy *outboundPolicyController) {
		snapshot := *policy.active.Load()
		snapshot.proxyDNS = resolver
		policy.publish(&snapshot, "confirmed")
		var err error
		gateway, err = policy.installGatewayDNS(ctx, resolver.work)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(gateway.server.close)
	}})
	query := new(dns.Msg).SetQuestion("service.example.net.", dns.TypeA)
	requireGatewayDNSAddress(t, gatewayUDPQuery(t, tap, cfg.GatewayIP, query, forwardWindow), "93.184.216.34")

	update := httptest.NewRecorder()
	gateway.ServeHTTP(update, httptest.NewRequest(http.MethodPost, "/services/dns/add", strings.NewReader(`{"name":"local.example.net.","defaultIP":"192.0.2.5"}`)))
	if update.Code != http.StatusOK {
		t.Fatalf("add DNS zone: %s", update.Body.String())
	}
	local := new(dns.Msg).SetQuestion("missing.local.example.net.", dns.TypeA)
	requireGatewayDNSAddress(t, gatewayUDPQuery(t, tap, cfg.GatewayIP, local, forwardWindow), "192.0.2.5")
	conn, err := startGuestStack(t, tap, cfg)(cfg.GatewayIP, 53)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	tcp := &dns.Conn{Conn: conn}
	requireGatewayDNSAddress(t, gatewayTCPQuery(t, tcp, query, forwardWindow), "93.184.216.34")
	requireGatewayDNSAddress(t, gatewayTCPQuery(t, tcp, local, forwardWindow), "192.0.2.5")
	if tunnels.Load() != 2 {
		t.Fatalf("two external port 53 queries opened %d tunnels", tunnels.Load())
	}

	snapshot := *tap.policy.active.Load()
	tap.policy.publish(&snapshot, "pending")
	if reply := gatewayTCPQuery(t, tcp, query, forwardWindow); reply.Rcode != dns.RcodeServerFailure {
		t.Fatalf("external query during cutover: %v", reply)
	}
	requireGatewayDNSAddress(t, gatewayTCPQuery(t, tcp, local, forwardWindow), "192.0.2.5")
	ips, err := snapshot.dialer.resolve(context.Background(), "service.example.net")
	if err != nil || len(ips) != 1 || ips[0].String() != "93.184.216.34" {
		t.Fatalf("captured business route resolved %v, error %v", ips, err)
	}
	// Leave the NIC up to model data already admitted by its packet gate.
	snapshot.policy.Mode = "disabled"
	tap.policy.publish(&snapshot, "confirmed")
	if reply := gateway.answer(context.Background(), query); reply != nil || tunnels.Load() != 4 {
		t.Fatalf("buffered DNS after disable: reply=%v, tunnels=%d", reply, tunnels.Load())
	}
}

func TestManagedDNSFaultsFailClosedWithoutChangingRoute(t *testing.T) {
	for _, fault := range []string{"proxy-stall", "resolver-stall", "invalid-resolver-response"} {
		t.Run(fault, func(t *testing.T) {
			t.Parallel()
			const budget = proxyDNSLookupTimeout + 2*time.Second
			const wantIPv4 = "93.184.216.34"
			const wantIPv6 = "2001:db8::34"
			var inject atomic.Bool
			var attempts, requests, directLookups, directDials atomic.Int32
			resolver, tunnels := startProxyDNSFixtureWithConnect(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				query := readFixtureDNSRequest(w, r)
				if query == nil {
					return
				}
				requests.Add(1)
				if inject.Load() && fault == "resolver-stall" {
					<-r.Context().Done()
					return
				}
				reply := new(dns.Msg).SetReply(query)
				question := query.Question[0]
				switch question.Qtype {
				case dns.TypeA:
					reply.Answer = []dns.RR{&dns.A{Hdr: fixtureDNSHeader(question.Name, dns.TypeA), A: net.ParseIP(wantIPv4)}}
				case dns.TypeAAAA:
					reply.Answer = []dns.RR{&dns.AAAA{Hdr: fixtureDNSHeader(question.Name, dns.TypeAAAA), AAAA: net.ParseIP(wantIPv6)}}
				}
				if inject.Load() && fault == "invalid-resolver-response" {
					reply.Id++
				}
				writeFixtureDNSReply(w, reply)
			}), func(r *http.Request) bool {
				attempts.Add(1)
				if inject.Load() && fault == "proxy-stall" {
					<-r.Context().Done()
					return false
				}
				return true
			})

			cfg := testGvproxyConfig()
			fallback := new(gatewayTestSystemResolver)
			tap := startNetworkWithSeams(t, cfg, networkSeams{
				resolve: func(ctx context.Context, host string) ([]net.IP, error) {
					directLookups.Add(1)
					return refuseResolve(ctx, host)
				},
				dial: func(ctx context.Context, network, address string) (net.Conn, error) {
					directDials.Add(1)
					return refuseDial(ctx, network, address)
				},
				beforeAttach: func(ctx context.Context, policy *outboundPolicyController) {
					gateway, err := policy.installManagedNetwork(ctx, resolver.work, resolver, nil)
					if err != nil {
						t.Fatal(err)
					}
					gateway.resolver = fallback
					t.Cleanup(gateway.server.close)
				},
			})
			installed := tap.policy.active.Load()
			// The TCP guest stack consumes the tap's received frames, so send
			// the hand-built UDP queries before attaching it.
			for _, entry := range []string{"gateway-udp", "gateway-tcp", "business-host"} {
				var tcp *dns.Conn
				if entry == "gateway-tcp" {
					conn, err := startGuestStack(t, tap, cfg)(cfg.GatewayIP, 53)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { _ = conn.Close() })
					tcp = &dns.Conn{Conn: conn}
				}
				probe := func(phase string, succeed bool) {
					t.Helper()
					name := phase + "." + entry + ".example.net."
					var query, reply *dns.Msg
					start := time.Now()
					switch entry {
					case "gateway-udp":
						query = new(dns.Msg).SetQuestion(name, dns.TypeA)
						reply = gatewayUDPQuery(t, tap, cfg.GatewayIP, query, budget)
					case "gateway-tcp":
						query = new(dns.Msg).SetQuestion(name, dns.TypeAAAA)
						reply = gatewayTCPQuery(t, tcp, query, budget)
					case "business-host":
						ctx, cancel := context.WithTimeout(context.Background(), budget)
						defer cancel()
						addresses, err := tap.policy.active.Load().dialer.resolve(ctx, name)
						if succeed {
							if err != nil || len(addresses) != 2 || addresses[0].String() != wantIPv4 || addresses[1].String() != wantIPv6 {
								t.Fatalf("%s: resolved %v, error %v", entry, addresses, err)
							}
						} else if len(addresses) != 0 || err == nil || (fault != "invalid-resolver-response" && !errors.Is(err, context.DeadlineExceeded)) {
							t.Fatalf("%s: fault %s yielded %v, error %v", entry, fault, addresses, err)
						}
					}
					elapsed := time.Since(start)
					if !succeed {
						t.Logf("%s: %s completed in %s", entry, fault, elapsed)
						if fault != "invalid-resolver-response" && (elapsed < proxyDNSLookupTimeout || elapsed > budget) {
							t.Fatalf("%s: %s completed in %s outside the DNS budget", entry, fault, elapsed)
						}
					}
					if reply == nil {
						return // The business lookup checked its returned addresses above.
					}
					if reply.Id != query.Id || len(reply.Question) != 1 || reply.Question[0] != query.Question[0] {
						t.Fatalf("%s: mismatched DNS response: %v", entry, reply)
					}
					if !succeed {
						if reply.Rcode != dns.RcodeServerFailure || len(reply.Answer) != 0 {
							t.Fatalf("%s: expected SERVFAIL without answers, got %v", entry, reply)
						}
						return
					}
					if query.Question[0].Qtype == dns.TypeA {
						requireGatewayDNSAddress(t, reply, wantIPv4)
					} else if reply.Rcode != dns.RcodeSuccess || len(reply.Answer) != 1 ||
						reply.Answer[0].Header().Rrtype != dns.TypeAAAA || reply.Answer[0].(*dns.AAAA).AAAA.String() != wantIPv6 {
						t.Fatalf("%s: unexpected AAAA response: %v", entry, reply)
					}
				}

				probe("before", true)
				attemptBefore, tunnelBefore, requestBefore := attempts.Load(), tunnels.Load(), requests.Load()
				inject.Store(true)
				probe("fault", false)
				inject.Store(false)
				wantEstablished := int32(1)
				if fault == "proxy-stall" {
					wantEstablished = 0
				}
				if attempts.Load()-attemptBefore != 1 || tunnels.Load()-tunnelBefore != wantEstablished || requests.Load()-requestBefore != wantEstablished {
					t.Fatalf("%s: fault %s reached wrong boundary: CONNECT=%d, tunnels=%d, DoH=%d", entry, fault,
						attempts.Load()-attemptBefore, tunnels.Load()-tunnelBefore, requests.Load()-requestBefore)
				}
				probe("after", true)
			}
			if fallback.calls.Load()+directLookups.Load()+directDials.Load() != 0 {
				t.Fatal("managed DNS probed a direct resolver or socket")
			}
			if tap.policy.active.Load() != installed || installed.state != "confirmed" || installed.proxyDNS != resolver {
				t.Fatal("managed DNS fault changed the confirmed route")
			}
		})
	}
}

type gatewayTestSystemResolver struct {
	hostDNSResolver
	calls atomic.Int32
}

func (r *gatewayTestSystemResolver) LookupIPAddr(_ context.Context, name string) ([]net.IPAddr, error) {
	r.calls.Add(1)
	return []net.IPAddr{{IP: net.IPv4(192, 0, 2, 31)}}, nil
}

func TestGatewayDNSUnboundUsesSystemResolverOnBothListeners(t *testing.T) {
	cfg := testGvproxyConfig()
	resolver := new(gatewayTestSystemResolver)
	tap := startNetworkWithSeams(t, cfg, networkSeams{beforeAttach: func(ctx context.Context, policy *outboundPolicyController) {
		gateway, err := policy.installGatewayDNS(ctx, newDNSLookupWork(ctx))
		if err != nil {
			t.Fatal(err)
		}
		gateway.resolver = resolver
		t.Cleanup(gateway.server.close)
	}})
	query := new(dns.Msg).SetQuestion("service.example.net.", dns.TypeA)
	requireGatewayDNSAddress(t, gatewayUDPQuery(t, tap, cfg.GatewayIP, query, forwardWindow), "192.0.2.31")
	conn, err := startGuestStack(t, tap, cfg)(cfg.GatewayIP, 53)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	requireGatewayDNSAddress(t, gatewayTCPQuery(t, &dns.Conn{Conn: conn}, query, forwardWindow), "192.0.2.31")
	if got := resolver.calls.Load(); got != 2 {
		t.Fatalf("unbound queries resolved %d times", got)
	}
}

func gatewayUDPQuery(t *testing.T, tap *guestTap, gateway string, query *dns.Msg, timeout time.Duration) *dns.Msg {
	t.Helper()
	wire, err := query.Pack()
	if err != nil {
		t.Fatal(err)
	}
	tap.send(t, udpFrame(t, gateway, 53, wire))
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case frame := <-tap.frames:
			if len(frame) < header.EthernetMinimumSize+header.IPv4MinimumSize || header.Ethernet(frame).Type() != header.IPv4ProtocolNumber {
				continue
			}
			ip := header.IPv4(frame[header.EthernetMinimumSize:])
			if ip.TransportProtocol() != header.UDPProtocolNumber || len(ip.Payload()) < header.UDPMinimumSize {
				continue
			}
			datagram := header.UDP(ip.Payload())
			reply := new(dns.Msg)
			if datagram.SourcePort() == 53 && reply.Unpack(datagram.Payload()) == nil && reply.Response && reply.Id == query.Id {
				return reply
			}
		case <-timer.C:
			t.Fatal("no gateway UDP DNS reply")
		}
	}
}

func gatewayTCPQuery(t *testing.T, conn *dns.Conn, query *dns.Msg, timeout time.Duration) *dns.Msg {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := conn.WriteMsg(query); err != nil {
		t.Fatal(err)
	}
	reply, err := conn.ReadMsg()
	if err != nil {
		t.Fatal(err)
	}
	return reply
}

func requireGatewayDNSAddress(t *testing.T, reply *dns.Msg, want string) {
	t.Helper()
	if reply.Rcode != dns.RcodeSuccess || len(reply.Answer) != 1 {
		t.Fatalf("unexpected DNS reply: %v", reply)
	}
	address, ok := reply.Answer[0].(*dns.A)
	if !ok || address.A.String() != want {
		t.Fatalf("DNS answer %v, want %s", reply.Answer[0], want)
	}
}
