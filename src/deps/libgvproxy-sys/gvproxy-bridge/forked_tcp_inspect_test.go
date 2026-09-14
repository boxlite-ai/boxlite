package main

// forked_tcp_inspect_test.go — the post-peek gate must decide before MITM.
//
// These tests drive the real virtual network the way udp_filter_test.go does,
// but the guest end is a second gVisor stack instead of hand-rolled frames:
// inspectAndForward performs the TCP handshake itself (CreateEndpoint) and
// then blocks reading guest data, so reaching its decision needs a real TCP
// client, not a bare SYN. gonet.DialContextTCP over a channel endpoint gives
// one, and hands back a net.Conn that tls.Client can drive.
//
// No upstream listener and no privileged port are involved: mitmAndForward
// generates the leaf certificate and completes the guest-side TLS handshake
// before its ReverseProxy ever dials upstream (mitm_proxy.go), so "did MITM
// run?" is answerable from the handshake alone.

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

const (
	// A secret host the guest presents in SNI. Never resolved: the test dials
	// an IP directly, which is exactly the shape that defeats the DNS sinkhole
	// in a real box (curl --resolve, /etc/hosts).
	secretSNI = "mitm-bypass.test"
	// Covers unlistedIP (198.51.100.9), so the destination is allowed by an
	// IP rule rather than by a hostname rule.
	coveringCIDR = "198.51.100.0/24"
)

// startGuestStack attaches a second gVisor stack to the tap as the guest, so
// tests get a real net.Conn instead of hand-built frames. Returns a dialer
// bound to that stack.
func startGuestStack(t *testing.T, tap *guestTap, cfg GvproxyConfig) func(dstIP string, port uint16) (net.Conn, error) {
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
		Destination: header4EmptySubnet(),
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

func header4EmptySubnet() tcpip.Subnet {
	subnet, err := tcpip.NewSubnet(tcpip.AddrFromSlice(net.IPv4zero.To4()), tcpip.MaskFromBytes(net.IPv4Mask(0, 0, 0, 0)))
	if err != nil {
		panic("empty IPv4 subnet: " + err.Error())
	}
	return subnet
}

// startInspectNetwork wires a box that has both an allow_net and a secret.
func startInspectNetwork(t *testing.T, allowNet []string, secretHost string) func(string, uint16) (net.Conn, error) {
	t.Helper()

	cfg := testGvproxyConfig()
	cfg.AllowNet = allowNet
	matcher := NewSecretHostMatcher([]SecretConfig{{
		Name:        "key",
		Hosts:       []string{secretHost},
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "real-value",
	}})
	tap := startNetworkWithMitm(t, cfg, networkMitm{
		ca:             newTestCA(t),
		secretMatcher:  matcher,
		stubResolution: true,
	})
	return startGuestStack(t, tap, cfg)
}

// tlsHandshakeTo drives a guest TLS handshake with the given SNI.
func tlsHandshakeTo(t *testing.T, dial func(string, uint16) (net.Conn, error), dstIP, sni string) (*tls.ConnectionState, error) {
	t.Helper()

	conn, err := dial(dstIP, 443)
	if err != nil {
		return nil, err
	}
	t.Cleanup(func() { _ = conn.Close() })

	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: true, // the identity under test is the issuer, checked below
	})
	if err := tlsConn.Handshake(); err != nil {
		return nil, err
	}
	state := tlsConn.ConnectionState()
	return &state, nil
}

// TestInspectTCP_MitmDoesNotAuthorizeUnlistedDestination is the reproducer for
// the MITM bypass: naming a host in Secret.hosts must not, by itself, let the
// guest reach an address allow_net does not cover.
func TestInspectTCP_MitmDoesNotAuthorizeUnlistedDestination(t *testing.T) {
	// allowedCIDR is 198.51.100.1/32 — it does NOT cover unlistedIP.
	dial := startInspectNetwork(t, []string{allowedCIDR}, secretSNI)

	state, err := tlsHandshakeTo(t, dial, unlistedIP, secretSNI)
	if err == nil {
		issuer := "<none>"
		if len(state.PeerCertificates) > 0 {
			issuer = state.PeerCertificates[0].Issuer.CommonName
		}
		t.Fatalf("TLS handshake to an unlisted destination succeeded; the MITM proxy "+
			"authorized egress on its own (leaf issued by %q)", issuer)
	}
}

// TestInspectTCP_MitmStillAppliesToAllowedDestination is the positive control
// for the test above: without it, a harness fault would read as a pass.
func TestInspectTCP_MitmStillAppliesToAllowedDestination(t *testing.T) {
	dial := startInspectNetwork(t, []string{coveringCIDR}, secretSNI)

	state, err := tlsHandshakeTo(t, dial, unlistedIP, secretSNI)
	if err != nil {
		t.Fatalf("TLS handshake to an allowed destination should be MITM'd, got: %v", err)
	}
	if len(state.PeerCertificates) == 0 {
		t.Fatal("expected a MITM-issued leaf certificate")
	}
	if issuer := state.PeerCertificates[0].Issuer.CommonName; issuer != "BoxLite Test CA" {
		t.Fatalf("leaf should be issued by the box CA, got issuer %q", issuer)
	}
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

// TestInspectTCP_CIDRRuleStillAllowsHTTPSWhenSecretsConfigured is the
// reproducer for the second half: configuring any secret must not silently
// disable allow_net's IP/CIDR rules on :443.
//
// Decision-level, not byte-level: proving the forward completed would need a
// listener on port 443, which CI cannot bind unprivileged.
func TestInspectTCP_CIDRRuleStillAllowsHTTPSWhenSecretsConfigured(t *testing.T) {
	const probeSNI = "cidr-probe.test"
	hook := captureLogs(t)

	// The destination is covered by a CIDR rule; the SNI is not a secret host
	// and not a hostname rule, so only MatchesIP can authorize it.
	dial := startInspectNetwork(t, []string{coveringCIDR}, secretSNI)
	_, _ = tlsHandshakeTo(t, dial, unlistedIP, probeSNI)

	msgs := hook.messagesFor(probeSNI)
	if containsPrefix(msgs, "allowNet TCP: blocked") {
		t.Fatalf("a CIDR-allowed destination was blocked on :443 because a secret "+
			"is configured; allow_net IP rules must survive. Logged: %v", msgs)
	}
	if !containsPrefix(msgs, "allowNet TCP: allowed") {
		t.Fatalf("expected an allow decision for %s, logged: %v", probeSNI, msgs)
	}
}

// TestInspectTCP_UnlistedDestinationStillBlocked is the control for the hook
// itself: without it the absence-assertion above could be vacuous.
func TestInspectTCP_UnlistedDestinationStillBlocked(t *testing.T) {
	const probeSNI = "blocked-probe.test"
	hook := captureLogs(t)

	dial := startInspectNetwork(t, []string{allowedCIDR}, secretSNI)
	_, _ = tlsHandshakeTo(t, dial, unlistedIP, probeSNI)

	msgs := hook.messagesFor(probeSNI)
	if !containsPrefix(msgs, "allowNet TCP: blocked") {
		t.Fatalf("expected a block decision for %s, logged: %v", probeSNI, msgs)
	}
}
