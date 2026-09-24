package main

// forked_tcp_inspect_test.go — what the gateway does once it has peeked a name.
//
// These tests drive the real virtual network the way udp_filter_test.go does,
// but the guest end is a second gVisor stack instead of hand-rolled frames:
// inspectAndForward performs the TCP handshake itself (CreateEndpoint) and
// then blocks reading guest data, so reaching its decision needs a real TCP
// client, not a bare SYN. gonet.DialContextTCP over a channel endpoint gives
// one, and hands back a net.Conn that tls.Client can drive.
//
// Decisions are observed through the forwarder's own log lines and through
// the dial seam, so no listener on a privileged port is needed and no packet
// leaves the process.

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/link/ethernet"
	"gvisor.dev/gvisor/pkg/tcpip/network/arp"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

// coveringCIDR covers unlistedIP (198.51.100.9), so a destination can be
// allowed by an IP rule rather than by a hostname rule.
const coveringCIDR = "198.51.100.0/24"

// guestDialer opens a TCP connection from the guest stack to dstIP:port.
type guestDialer func(dstIP string, port uint16) (net.Conn, error)

// startGuestStack attaches a second gVisor stack to the tap as the guest, so
// tests get a real net.Conn instead of hand-built frames.
func startGuestStack(t *testing.T, tap *guestTap, cfg GvproxyConfig) guestDialer {
	t.Helper()

	guestMAC, err := net.ParseMAC(cfg.GuestMac)
	if err != nil {
		t.Fatalf("parse guest MAC: %v", err)
	}

	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol, arp.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
	})
	t.Cleanup(s.Close)

	ch := channel.New(512, uint32(cfg.MTU), tcpip.LinkAddress(guestMAC))
	const nicID = tcpip.NICID(1)
	if err := s.CreateNIC(nicID, ethernet.New(ch)); err != nil {
		t.Fatalf("CreateNIC: %v", err)
	}

	guestAddr := tcpip.AddrFromSlice(net.ParseIP(cfg.GuestIP).To4())
	if err := s.AddProtocolAddress(nicID, tcpip.ProtocolAddress{
		Protocol:          ipv4.ProtocolNumber,
		AddressWithPrefix: guestAddr.WithPrefix(),
	}, stack.AddressProperties{}); err != nil {
		t.Fatalf("AddProtocolAddress: %v", err)
	}
	s.SetRouteTable([]tcpip.Route{{
		Destination: emptyIPv4Subnet(),
		Gateway:     tcpip.AddrFromSlice(net.ParseIP(cfg.GatewayIP).To4()),
		NIC:         nicID,
	}})

	// guest stack → gateway: length-prefixed frames, matching wrapConn's
	// framing on the other end of the pipe.
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		for {
			pkt := ch.ReadContext(ctx)
			if pkt == nil {
				return
			}
			frame := pkt.ToView().AsSlice()
			pkt.DecRef()
			var size [4]byte
			binary.BigEndian.PutUint32(size[:], uint32(len(frame)))
			if _, err := tap.conn.Write(append(size[:], frame...)); err != nil {
				return
			}
		}
	}()

	// gateway → guest stack. guestTap.readLoop already owns the socket read
	// side and republishes frames on tap.frames.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-tap.frames:
				ch.InjectInbound(ipv4.ProtocolNumber, stack.NewPacketBuffer(stack.PacketBufferOptions{
					Payload: buffer.MakeWithData(frame),
				}))
			}
		}
	}()

	return func(dstIP string, port uint16) (net.Conn, error) {
		dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer dialCancel()
		return gonet.DialContextTCP(dialCtx, s, tcpip.FullAddress{
			NIC:  nicID,
			Addr: tcpip.AddrFromSlice(net.ParseIP(dstIP).To4()),
			Port: port,
		}, ipv4.ProtocolNumber)
	}
}

func emptyIPv4Subnet() tcpip.Subnet {
	subnet, err := tcpip.NewSubnet(tcpip.AddrFromSlice(net.IPv4zero.To4()), tcpip.MaskFromBytes(net.IPv4Mask(0, 0, 0, 0)))
	if err != nil {
		panic("empty IPv4 subnet: " + err.Error())
	}
	return subnet
}

// tlsHandshakeTo drives a guest TLS handshake with the given SNI. The
// handshake only completes against the MITM proxy; for a plain forward it
// fails once the peeked bytes are relayed nowhere, which is fine — the
// forwarder's decision has been logged by then.
func tlsHandshakeTo(t *testing.T, dial guestDialer, dstIP, sni string) (*tls.ConnectionState, error) {
	t.Helper()

	conn, err := dial(dstIP, 443)
	if err != nil {
		return nil, err
	}
	t.Cleanup(func() { _ = conn.Close() })

	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: true, // the identity under test is the issuer, checked by callers
	})
	if err := tlsConn.Handshake(); err != nil {
		return nil, err
	}
	state := tlsConn.ConnectionState()
	return &state, nil
}

// logCapture collects logrus entries for the duration of one test. Fire runs
// on whichever gvproxy goroutine logged, so the slice needs a lock: the
// forwarder decides on a stack goroutine while the test thread reads.
type logCapture struct {
	mu      sync.Mutex
	entries []*logrus.Entry
}

func (c *logCapture) Levels() []logrus.Level { return logrus.AllLevels }
func (c *logCapture) Fire(e *logrus.Entry) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = append(c.entries, e)
	return nil
}

// messagesFor returns the log messages recorded for one hostname field.
func (c *logCapture) messagesFor(hostname string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, e := range c.entries {
		if got, ok := e.Data["hostname"]; ok && got == hostname {
			out = append(out, e.Message)
		}
	}
	return out
}

// awaitDecision waits until the forwarder has logged an allow or block for
// hostname. The decision is made on a stack goroutine after the guest's
// ClientHello lands, so a plain read right after the handshake attempt races it.
func (c *logCapture) awaitDecision(t *testing.T, hostname string) []string {
	t.Helper()
	deadline := time.Now().Add(forwardWindow)
	for {
		msgs := c.messagesFor(hostname)
		if containsPrefix(msgs, "allowNet TCP: allowed") || containsPrefix(msgs, "allowNet TCP: blocked") {
			return msgs
		}
		if time.Now().After(deadline) {
			t.Fatalf("no allow/block decision logged for %s within %v; logged: %v", hostname, forwardWindow, msgs)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// captureLogs installs the hook for one test and takes it back out again.
// logrus has no RemoveHook, so the previous hook set is swapped in wholesale on
// cleanup; leaving the hook registered would keep collecting every later test's
// entries in this package.
func captureLogs(t *testing.T) *logCapture {
	t.Helper()
	hook := &logCapture{}
	logger := logrus.StandardLogger()
	level := logger.GetLevel()
	previous := logger.ReplaceHooks(logrus.LevelHooks{})

	// Copy the saved set per level — re-adding hook by hook would register a
	// multi-level hook once for every level it already covered.
	restored := logrus.LevelHooks{}
	for lvl, hooks := range previous {
		restored[lvl] = append([]logrus.Hook(nil), hooks...)
	}
	logger.ReplaceHooks(restored)
	// AddHook takes the logger's lock; Hooks.Add would mutate the map while
	// gvproxy goroutines are firing hooks.
	logger.AddHook(hook)
	logger.SetLevel(logrus.DebugLevel)
	t.Cleanup(func() {
		logger.ReplaceHooks(previous)
		logger.SetLevel(level)
	})
	return hook
}

func containsPrefix(msgs []string, prefix string) bool {
	for _, m := range msgs {
		if len(m) >= len(prefix) && m[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

// nameTable is a mutable resolver seam: what the host resolver would answer
// for each name right now. Tests flip entries to simulate a destination whose
// address changes while the box is running.
type nameTable struct {
	mu    sync.Mutex
	addrs map[string][]string
}

func newNameTable(addrs map[string][]string) *nameTable {
	return &nameTable{addrs: addrs}
}

func (n *nameTable) set(name string, addrs ...string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.addrs[name] = addrs
}

func (n *nameTable) resolve(_ context.Context, host string) ([]net.IP, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	addrs, ok := n.addrs[canonicalHostname(host)]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	out := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, net.ParseIP(a).To4())
	}
	return out, nil
}

// startByNameNetwork wires a box whose only egress policy is allowNet and
// whose host resolver is the given table. Nothing is dialed: the decision is
// read from the forwarder's log and, where a test needs it, from a dial seam
// passed through startNetworkWithSeams instead.
func startByNameNetwork(t *testing.T, allowNet []string, names *nameTable) guestDialer {
	t.Helper()
	cfg := testGvproxyConfig()
	cfg.AllowNet = allowNet
	tap := startNetworkWithSeams(t, cfg, networkSeams{resolve: names.resolve})
	return startGuestStack(t, tap, cfg)
}

// TestInspectTCP_WildcardSubdomainOnDifferentIPThanApexIsReachable: a
// wildcard rule covers every subdomain, each of which is its own name with
// its own address. cdn.example.test lives on 198.51.100.9 while the apex is
// on 198.51.100.1; the guest must be able to reach it.
func TestInspectTCP_WildcardSubdomainOnDifferentIPThanApexIsReachable(t *testing.T) {
	const host = "cdn.example.test"
	hook := captureLogs(t)
	names := newNameTable(map[string][]string{
		"example.test": {"198.51.100.1"},
		host:           {unlistedIP},
	})

	dial := startByNameNetwork(t, []string{"*.example.test"}, names)
	_, _ = tlsHandshakeTo(t, dial, unlistedIP, host)

	msgs := hook.awaitDecision(t, host)
	if !containsPrefix(msgs, "allowNet TCP: allowed") {
		t.Fatalf("a subdomain under an allowed wildcard was refused because it does not share the apex's address; logged: %v", msgs)
	}
}

// TestInspectTCP_HostWhoseAddressChangesAfterStartIsReachable: a destination
// that moves after the box started must stay reachable — the rule names the
// host, not the address it had at boot.
func TestInspectTCP_HostWhoseAddressChangesAfterStartIsReachable(t *testing.T) {
	const host = "api.example.test"
	hook := captureLogs(t)
	names := newNameTable(map[string][]string{host: {"198.51.100.1"}})

	dial := startByNameNetwork(t, []string{host}, names)

	// Control: the address the name had at start is reachable on any tree.
	_, _ = tlsHandshakeTo(t, dial, "198.51.100.1", host)
	if msgs := hook.awaitDecision(t, host); !containsPrefix(msgs, "allowNet TCP: allowed") {
		t.Fatalf("control failed: the start-time address was refused; logged: %v", msgs)
	}

	// The host moves. The guest resolves again, gets the new address, connects.
	names.set(host, unlistedIP)
	before := len(hook.messagesFor(host))
	_, _ = tlsHandshakeTo(t, dial, unlistedIP, host)

	msgs := hook.awaitDecision(t, host)[before:]
	if !containsPrefix(msgs, "allowNet TCP: allowed") {
		t.Fatalf("after the host changed address, the connection was refused; logged: %v", msgs)
	}
}

// awaitDial waits for the forwarder's dial seam to be used once. The dial
// happens on a stack goroutine after the decision is logged.
func awaitDial(t *testing.T, rec *dialRecorder) []string {
	t.Helper()
	deadline := time.Now().Add(forwardWindow)
	for {
		if dialed := rec.snapshot(); len(dialed) > 0 {
			return dialed
		}
		if time.Now().After(deadline) {
			t.Fatal("the forwarder never dialed upstream")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestInspectTCP_DialsResolvedAddressNotGuestAddress is the domain-fronting
// property, now held by construction: a guest that dials an attacker's
// address while presenting an allowed SNI reaches the allowed host, because
// the gateway dials what the name resolves to and never what the guest chose.
func TestInspectTCP_DialsResolvedAddressNotGuestAddress(t *testing.T) {
	const host = "allowed.example"
	names := newNameTable(map[string][]string{host: {"198.51.100.1"}})
	rec := &dialRecorder{fail: map[string]error{}}
	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{host}
	tap := startNetworkWithSeams(t, cfg, networkSeams{resolve: names.resolve, dial: rec.dial})
	dial := startGuestStack(t, tap, cfg)

	_, _ = tlsHandshakeTo(t, dial, unlistedIP, host) // 198.51.100.9 is the attacker's address

	dialed := awaitDial(t, rec)
	if len(dialed) != 1 || dialed[0] != "tcp4 198.51.100.1:443" {
		t.Fatalf("gateway dialed %v; it must dial the name's own address 198.51.100.1:443 and never the guest's 198.51.100.9", dialed)
	}
}

// TestInspectTCP_IPRuleStillDialsGuestAddress: a destination allowed by an
// IP/CIDR rule is dialed exactly as the guest addressed it, NAT applied —
// the path host.boxlite.internal depends on. Secrets are configured so :443
// goes through inspection instead of the standard forward.
func TestInspectTCP_IPRuleStillDialsGuestAddress(t *testing.T) {
	const probeSNI = "cidr-probe.test"
	rec := &dialRecorder{fail: map[string]error{}}
	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{coveringCIDR}
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		ca:            newTestCA(t),
		secretMatcher: NewSecretHostMatcher([]SecretConfig{{Name: "k", Hosts: []string{"secret.example"}, Placeholder: "<S>", Value: "v"}}),
		dial:          rec.dial,
	})
	dial := startGuestStack(t, tap, cfg)

	_, _ = tlsHandshakeTo(t, dial, unlistedIP, probeSNI)

	// unlistedIP is NAT-mapped to loopback by the harness, as the host alias is
	// in a box; the by-address dial must carry that translation.
	dialed := awaitDial(t, rec)
	if len(dialed) != 1 || dialed[0] != "tcp 127.0.0.1:443" {
		t.Fatalf("gateway dialed %v; an IP-rule match must dial the guest's (NAT-translated) address", dialed)
	}
}

// TestInspectTCP_ResolvedPrivateAddressRefusedUnlessListed: a public name
// that resolves into a private range is not dialed on the strength of the
// hostname rule alone; listing the range grants it.
func TestInspectTCP_ResolvedPrivateAddressRefusedUnlessListed(t *testing.T) {
	const host = "internal.example"
	names := newNameTable(map[string][]string{host: {"10.0.0.5"}})

	t.Run("hostname rule alone", func(t *testing.T) {
		hook := captureLogs(t)
		rec := &dialRecorder{fail: map[string]error{}}
		cfg := testGvproxyConfig()
		cfg.AllowNet = []string{host}
		tap := startNetworkWithSeams(t, cfg, networkSeams{resolve: names.resolve, dial: rec.dial})
		dial := startGuestStack(t, tap, cfg)

		_, _ = tlsHandshakeTo(t, dial, unlistedIP, host)

		deadline := time.Now().Add(forwardWindow)
		for !containsPrefix(hook.messagesFor(host), "allowNet TCP: blocked (resolved address unroutable)") {
			if time.Now().After(deadline) {
				t.Fatalf("expected the private answer to be refused; logged %v, dialed %v", hook.messagesFor(host), rec.snapshot())
			}
			time.Sleep(10 * time.Millisecond)
		}
		if dialed := rec.snapshot(); len(dialed) != 0 {
			t.Fatalf("a private answer must not be dialed, got %v", dialed)
		}
	})

	t.Run("range listed", func(t *testing.T) {
		rec := &dialRecorder{fail: map[string]error{}}
		cfg := testGvproxyConfig()
		cfg.AllowNet = []string{host, "10.0.0.0/8"}
		tap := startNetworkWithSeams(t, cfg, networkSeams{resolve: names.resolve, dial: rec.dial})
		dial := startGuestStack(t, tap, cfg)

		_, _ = tlsHandshakeTo(t, dial, unlistedIP, host)

		if dialed := awaitDial(t, rec); len(dialed) != 1 || dialed[0] != "tcp4 10.0.0.5:443" {
			t.Fatalf("with the range listed the gateway must dial 10.0.0.5:443, got %v", dialed)
		}
	})
}

// TestInspectTCP_HostHeaderIPLiteralIsNotAHostname: an IP literal in the
// Host header names no host, so under hostname-only rules it is blocked; it
// must not become a way for the guest to choose the dialed address.
func TestInspectTCP_HostHeaderIPLiteralIsNotAHostname(t *testing.T) {
	hook := captureLogs(t)
	rec := &dialRecorder{fail: map[string]error{}}
	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{"api.example.test"}
	tap := startNetworkWithSeams(t, cfg, networkSeams{dial: rec.dial})
	dial := startGuestStack(t, tap, cfg)

	conn, err := dial(unlistedIP, 80)
	if err != nil {
		t.Fatalf("guest dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("GET / HTTP/1.1\r\nHost: " + unlistedIP + "\r\n\r\n")); err != nil {
		t.Fatalf("write request: %v", err)
	}

	msgs := hook.awaitDecision(t, "")
	if !containsPrefix(msgs, "allowNet TCP: blocked") {
		t.Fatalf("an IP-literal Host header must be blocked under hostname-only rules; logged %v", msgs)
	}
	if dialed := rec.snapshot(); len(dialed) != 0 {
		t.Fatalf("nothing may be dialed, got %v", dialed)
	}
}

// TestInspectTCP_MitmDialsByName: the credential goes to the host the secret
// names, not to the address the guest connected to.
func TestInspectTCP_MitmDialsByName(t *testing.T) {
	const host = "secret.example"
	names := newNameTable(map[string][]string{host: {"198.51.100.1"}})
	rec := &dialRecorder{fail: map[string]error{}}
	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{coveringCIDR}
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		ca:            newTestCA(t),
		secretMatcher: NewSecretHostMatcher([]SecretConfig{{Name: "k", Hosts: []string{host}, Placeholder: "<S>", Value: "v"}}),
		resolve:       names.resolve,
		dial:          rec.dial,
	})
	dial := startGuestStack(t, tap, cfg)

	conn, err := dial(unlistedIP, 443)
	if err != nil {
		t.Fatalf("guest dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	tlsConn := tls.Client(conn, &tls.Config{ServerName: host, InsecureSkipVerify: true})
	if err := tlsConn.Handshake(); err != nil {
		t.Fatalf("TLS handshake with the MITM proxy: %v", err)
	}
	if issuer := tlsConn.ConnectionState().PeerCertificates[0].Issuer.CommonName; issuer != "BoxLite Test CA" {
		t.Fatalf("leaf should be issued by the box CA, got %q", issuer)
	}
	// The proxy only dials upstream once a request arrives.
	_, _ = tlsConn.Write([]byte("GET / HTTP/1.1\r\nHost: " + host + "\r\n\r\n"))

	if dialed := awaitDial(t, rec); dialed[0] != "tcp4 198.51.100.1:443" {
		t.Fatalf("MITM dialed %v; it must dial the secret host's own address", dialed)
	}
}

// TestInspectTCP_ResolvableUnlistedNameIsRefused: DNS no longer gates
// anything, so a name outside the allowlist resolves for the guest like any
// other name. The refusal happens here instead, when the gateway decides what
// to dial. The name table deliberately holds an address for it: resolution was
// available and is not the reason the connection was refused.
func TestInspectTCP_ResolvableUnlistedNameIsRefused(t *testing.T) {
	const host = "blocked.test"
	hook := captureLogs(t)
	rec := &dialRecorder{}
	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{"api.example.test"}
	names := newNameTable(map[string][]string{
		host:               {"198.51.100.9"},
		"api.example.test": {"198.51.100.1"},
	})
	tap := startNetworkWithSeams(t, cfg, networkSeams{resolve: names.resolve, dial: rec.dial})
	dial := startGuestStack(t, tap, cfg)

	_, _ = tlsHandshakeTo(t, dial, unlistedIP, host)

	if msgs := hook.awaitDecision(t, host); !containsPrefix(msgs, "allowNet TCP: blocked") {
		t.Fatalf("an unlisted name must be refused at connect time; logged %v", msgs)
	}
	if dialed := rec.snapshot(); len(dialed) != 0 {
		t.Fatalf("nothing may be dialed for an unlisted name, got %v", dialed)
	}
}
