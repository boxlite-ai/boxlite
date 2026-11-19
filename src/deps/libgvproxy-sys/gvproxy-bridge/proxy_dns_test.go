package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"
)

const testDNSResolverName = "resolver.example.net"

func startProxyDNSFixture(t *testing.T, handler http.Handler) (*proxyDNSResolver, *atomic.Int32) {
	t.Helper()
	dnsTLS, roots := proxyTestTLS(t, newTestCA(t), testDNSResolverName)
	resolver := httptest.NewUnstartedServer(handler)
	resolver.TLS = dnsTLS
	resolver.StartTLS()
	t.Cleanup(resolver.Close)

	resolverAddress := netip.AddrPortFrom(proxyTestFirstIP, 443)
	var transitions atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.RequestURI != resolverAddress.String() {
			http.Error(w, "wrong tunnel target", http.StatusForbidden)
			return
		}
		upstream, err := net.Dial("tcp", resolver.Listener.Addr().String())
		if err != nil {
			http.Error(w, "resolver unavailable", http.StatusBadGateway)
			return
		}
		defer upstream.Close()
		guest, buffered, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer guest.Close()
		transitions.Add(1)
		if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return
		}
		if err := buffered.Flush(); err != nil {
			return
		}
		guestFinished := make(chan struct{})
		go func() {
			_, _ = io.Copy(upstream, buffered)
			_ = upstream.Close()
			close(guestFinished)
		}()
		_, _ = io.Copy(guest, upstream)
		_ = guest.Close()
		<-guestFinished
	}))
	t.Cleanup(proxy.Close)
	config := proxyTestConfig("http")
	dial := proxyTestDial(proxyTestPeer{address: proxy.Listener.Addr().String()}, config.endpoint)
	connect, err := newRegisteredProxyConnector(config, proxyTestTLSName, config.endpoint.Port(), func(_ context.Context, host string) ([]net.IP, error) {
		if host != proxyTestTLSName+"." {
			return nil, fmt.Errorf("unexpected host lookup %s", host)
		}
		return []net.IP{net.IPv4(127, 0, 0, 1), net.IP(config.endpoint.Addr().AsSlice())}, nil
	}, dial)
	if err != nil {
		t.Fatal(err)
	}
	client, err := newProxyDNSResolver("https://"+testDNSResolverName+"/dns-query", resolverAddress, roots, connect, newDNSLookupWork(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	return client, &transitions
}

func TestProxyDNSLookupFollowsOnlyAnswerAliases(t *testing.T) {
	resolver, tunnels := startProxyDNSFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := readFixtureDNSRequest(w, r)
		if query == nil {
			return
		}
		reply := new(dns.Msg).SetReply(query)
		question := query.Question[0]
		switch {
		case question.Qtype == dns.TypeA && question.Name == "service.example.net.":
			reply.Answer = []dns.RR{
				&dns.CNAME{Hdr: fixtureDNSHeader(question.Name, dns.TypeCNAME), Target: "alias.example.net."},
				&dns.A{Hdr: fixtureDNSHeader("unrelated.example.net.", dns.TypeA), A: net.IPv4(127, 0, 0, 1)},
			}
		case question.Qtype == dns.TypeA && question.Name == "alias.example.net.":
			reply.Answer = []dns.RR{&dns.A{Hdr: fixtureDNSHeader(question.Name, dns.TypeA), A: net.IPv4(93, 184, 216, 34)}}
		case question.Qtype == dns.TypeAAAA && question.Name == "service.example.net.":
			reply.Answer = []dns.RR{&dns.AAAA{Hdr: fixtureDNSHeader(question.Name, dns.TypeAAAA), AAAA: net.ParseIP("2001:4860::1")}}
		default:
			http.Error(w, "unexpected question", http.StatusBadRequest)
			return
		}
		writeFixtureDNSReply(w, reply)
	}))
	addresses, err := resolver.lookupIP(context.Background(), "Service.Example.Net")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, address := range addresses {
		got = append(got, address.String())
	}
	if !slices.Equal(got, []string{"93.184.216.34", "2001:4860::1"}) || tunnels.Load() != 3 {
		t.Fatalf("addresses=%v, tunnels=%d", got, tunnels.Load())
	}
}

func TestProxyDNSRefusesInvalidHTTPSResponses(t *testing.T) {
	for _, test := range []struct {
		name string
		send func(http.ResponseWriter, *dns.Msg)
		want string
	}{
		{"redirect", func(w http.ResponseWriter, _ *dns.Msg) {
			w.Header().Set("Location", "https://"+testDNSResolverName+"/redirected")
			w.WriteHeader(http.StatusTemporaryRedirect)
		}, "status 307"},
		{"wrong ID", func(w http.ResponseWriter, query *dns.Msg) {
			reply := new(dns.Msg).SetReply(query)
			reply.Id++
			writeFixtureDNSReply(w, reply)
		}, "does not match request"},
		{"oversized", func(w http.ResponseWriter, _ *dns.Msg) {
			w.Header().Set("Content-Type", dnsMessageMediaType)
			_ = http.NewResponseController(w).Flush()
			_, _ = w.Write(make([]byte, dns.MaxMsgSize+1))
		}, "oversized"},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver, tunnels := startProxyDNSFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if query := readFixtureDNSRequest(w, r); query != nil {
					test.send(w, query)
				}
			}))
			ctx, cancel := context.WithTimeout(context.Background(), proxyDNSLookupTimeout)
			defer cancel()
			answer, err := resolver.query(ctx, new(dns.Msg).SetQuestion("service.example.net.", dns.TypeA))
			if err == nil || !strings.Contains(err.Error(), test.want) || answer != nil || tunnels.Load() != 1 {
				t.Fatalf("answer=%v, error=%v, tunnels=%d", answer, err, tunnels.Load())
			}
		})
	}
}

func TestProxyDNSLookupDeadlineAppliesToLaterExchange(t *testing.T) {
	receivedAAAA := make(chan struct{})
	resolver, tunnels := startProxyDNSFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := readFixtureDNSRequest(w, r)
		if query == nil {
			return
		}
		if query.Question[0].Qtype == dns.TypeAAAA {
			close(receivedAAAA)
			<-r.Context().Done()
			return
		}
		writeFixtureDNSReply(w, new(dns.Msg).SetReply(query))
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	addresses, err := resolver.lookupIP(ctx, "service.example.net")
	if err == nil || len(addresses) != 0 || ctx.Err() == nil || tunnels.Load() != 2 {
		t.Fatalf("addresses=%v, error=%v, tunnels=%d", addresses, err, tunnels.Load())
	}
	select {
	case <-receivedAAAA:
	default:
		t.Fatal("later DNS exchange did not reach the resolver")
	}
}

func TestProxyDNSCapacityRejectsBeforeOpeningATunnel(t *testing.T) {
	entered := make(chan struct{})
	client, tunnels := startProxyDNSFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if query := readFixtureDNSRequest(w, r); query != nil {
			close(entered)
			<-r.Context().Done()
		}
	}))
	instance, cancel := context.WithCancel(context.Background())
	defer cancel()
	client.work = newDNSLookupWork(instance)
	query := func() *dns.Msg { return new(dns.Msg).SetQuestion("service.example.net.", dns.TypeA) }
	finished := make(chan error, 1)
	go func() {
		_, err := client.query(context.Background(), query())
		finished <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("lookup did not reach the pinned resolver")
	}
	for range dnsConcurrentLookups - 1 {
		_, release, err := client.work.begin(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer release()
	}
	if _, err := client.query(context.Background(), query()); !errors.Is(err, errDNSLookupCapacity) || tunnels.Load() != 1 {
		t.Fatalf("saturated DNS lookup: error=%v, tunnels=%d", err, tunnels.Load())
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("shutdown lookup error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("instance shutdown did not cancel the DNS lookup")
	}
}

func TestProxyDNSShutdownJoinsTLSConnectionClosure(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	raw, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	peer, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	release := make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	conn := &blockedTunnelClose{Conn: raw, started: make(chan struct{}), release: release}
	instance, cancel := context.WithCancel(context.Background())
	defer cancel()
	work := newDNSLookupWork(instance)
	resolver, err := newProxyDNSResolver("https://resolver.example/dns-query", netip.MustParseAddrPort("192.0.2.8:443"), nil,
		func(context.Context, egressTarget) (net.Conn, error) { return conn, nil }, work)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := resolver.query(context.Background(), new(dns.Msg).SetQuestion("example.test.", dns.TypeA))
		result <- err
	}()
	if err := peer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var hello [1]byte
	if _, err := io.ReadFull(peer, hello[:]); err != nil || hello[0] != 0x16 {
		t.Fatalf("did not start TLS handshake on the tunneled socket: %v", err)
	}
	cancel()
	select {
	case <-conn.started:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not start closing the TLS socket")
	}
	shutdown := make(chan struct{})
	go func() {
		work.waitForShutdown()
		close(shutdown)
	}()
	select {
	case <-shutdown:
		t.Fatal("managed DNS shutdown returned while the tunneled socket was still open")
	case <-time.After(300 * time.Millisecond):
	}
	unblock()
	select {
	case <-shutdown:
	case <-time.After(time.Second):
		t.Fatal("DNS shutdown did not finish after the socket closed")
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled TLS lookup returned %v", err)
	}
}

func TestProxyDNSShutdownJoinsActiveRequestTunnelClose(t *testing.T) {
	received := make(chan struct{})
	resolver, _ := startProxyDNSFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if readFixtureDNSRequest(w, r) != nil {
			close(received)
			<-r.Context().Done()
		}
	}))
	release := make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	closing := &blockedTunnelClose{started: make(chan struct{}), release: release}
	connect := resolver.connect
	resolver.connect = func(ctx context.Context, target egressTarget) (net.Conn, error) {
		conn, err := connect(ctx, target)
		if err != nil {
			return nil, err
		}
		closing.Conn = conn
		return closing, nil
	}
	instance, cancel := context.WithCancel(context.Background())
	defer cancel()
	resolver.work = newDNSLookupWork(instance)
	result := make(chan error, 1)
	go func() {
		_, err := resolver.query(context.Background(), new(dns.Msg).SetQuestion("example.test.", dns.TypeA))
		result <- err
	}()
	select {
	case <-received:
	case <-time.After(time.Second):
		t.Fatal("DNS request did not reach the loopback server")
	}
	cancel()
	select {
	case <-closing.started:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not start closing the tunnel")
	}
	shutdown := make(chan struct{})
	go func() {
		resolver.work.waitForShutdown()
		close(shutdown)
	}()
	select {
	case <-shutdown:
		t.Fatal("DNS shutdown returned before the initiating close finished")
	case <-time.After(100 * time.Millisecond):
	}
	unblock()
	select {
	case <-shutdown:
	case <-time.After(time.Second):
		t.Fatal("DNS shutdown did not finish after the tunnel closed")
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled DNS request returned %v", err)
	}
	if attempts := closing.calls.Load(); attempts != 1 {
		t.Fatalf("underlying tunnel closed %d times, want once", attempts)
	}
}

func readFixtureDNSRequest(w http.ResponseWriter, r *http.Request) *dns.Msg {
	if r.Method != http.MethodPost || r.URL.Path != "/dns-query" || r.Host != testDNSResolverName ||
		r.Header.Get("Content-Type") != dnsMessageMediaType || r.Header.Get("Accept") != dnsMessageMediaType {
		http.Error(w, "unexpected DNS HTTPS request", http.StatusBadRequest)
		return nil
	}
	var body bytes.Buffer
	_, err := io.Copy(&body, r.Body)
	query := new(dns.Msg)
	if err != nil || query.Unpack(body.Bytes()) != nil || len(query.Question) != 1 {
		http.Error(w, "invalid DNS request", http.StatusBadRequest)
		return nil
	}
	return query
}

func writeFixtureDNSReply(w http.ResponseWriter, reply *dns.Msg) {
	wire, err := reply.Pack()
	if err != nil {
		http.Error(w, fmt.Sprint(err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", dnsMessageMediaType)
	_, _ = w.Write(wire)
}

func fixtureDNSHeader(name string, recordType uint16) dns.RR_Header {
	return dns.RR_Header{Name: name, Rrtype: recordType, Class: dns.ClassINET, Ttl: 60}
}
