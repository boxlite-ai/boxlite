package main

import (
	"context"
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
	if reply := gatewayTCPQuery(t, open(), query); reply.Rcode != dns.RcodeSuccess {
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
	requireGatewayDNSAddress(t, gatewayUDPQuery(t, tap, cfg.GatewayIP, query), "93.184.216.34")

	update := httptest.NewRecorder()
	gateway.ServeHTTP(update, httptest.NewRequest(http.MethodPost, "/services/dns/add", strings.NewReader(`{"name":"local.example.net.","defaultIP":"192.0.2.5"}`)))
	if update.Code != http.StatusOK {
		t.Fatalf("add DNS zone: %s", update.Body.String())
	}
	local := new(dns.Msg).SetQuestion("missing.local.example.net.", dns.TypeA)
	requireGatewayDNSAddress(t, gatewayUDPQuery(t, tap, cfg.GatewayIP, local), "192.0.2.5")
	conn, err := startGuestStack(t, tap, cfg)(cfg.GatewayIP, 53)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	tcp := &dns.Conn{Conn: conn}
	requireGatewayDNSAddress(t, gatewayTCPQuery(t, tcp, query), "93.184.216.34")
	requireGatewayDNSAddress(t, gatewayTCPQuery(t, tcp, local), "192.0.2.5")
	if tunnels.Load() != 2 {
		t.Fatalf("two external port 53 queries opened %d tunnels", tunnels.Load())
	}

	snapshot := *tap.policy.active.Load()
	tap.policy.publish(&snapshot, "pending")
	if reply := gatewayTCPQuery(t, tcp, query); reply.Rcode != dns.RcodeServerFailure {
		t.Fatalf("external query during cutover: %v", reply)
	}
	requireGatewayDNSAddress(t, gatewayTCPQuery(t, tcp, local), "192.0.2.5")
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
	requireGatewayDNSAddress(t, gatewayUDPQuery(t, tap, cfg.GatewayIP, query), "192.0.2.31")
	conn, err := startGuestStack(t, tap, cfg)(cfg.GatewayIP, 53)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	requireGatewayDNSAddress(t, gatewayTCPQuery(t, &dns.Conn{Conn: conn}, query), "192.0.2.31")
	if got := resolver.calls.Load(); got != 2 {
		t.Fatalf("unbound queries resolved %d times", got)
	}
}

func gatewayUDPQuery(t *testing.T, tap *guestTap, gateway string, query *dns.Msg) *dns.Msg {
	t.Helper()
	wire, err := query.Pack()
	if err != nil {
		t.Fatal(err)
	}
	tap.send(t, udpFrame(t, gateway, 53, wire))
	timer := time.NewTimer(forwardWindow)
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

func gatewayTCPQuery(t *testing.T, conn *dns.Conn, query *dns.Msg) *dns.Msg {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(forwardWindow))
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
