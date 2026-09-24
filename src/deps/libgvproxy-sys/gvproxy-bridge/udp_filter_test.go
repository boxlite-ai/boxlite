package main

// udp_filter_test.go — allow_net must apply to UDP, not only TCP.
//
// These tests drive the real virtual network the way a guest does: raw
// Ethernet frames over the qemu stream protocol into vn.AcceptQemu. Nothing
// is stubbed — the packets traverse the same gVisor stack, the same NAT
// table, and the same transport handlers a running box uses.
//
// The unlisted destination is a TEST-NET address (198.51.100.9) that the
// config NAT-maps to loopback, so the forwarder's net.Dial lands on a
// test-owned listener instead of the internet. Policy is evaluated on the
// pre-NAT address (forked_tcp.go:83), so 198.51.100.9 is what the allowlist
// sees, exactly as it would for a real public IP.

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/checksum"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

const (
	unlistedIP   = "198.51.100.9"
	allowedCIDR  = "198.51.100.1/32"
	guestSrcPort = 41234
	probePayload = "BOXLITE_UDP_ALLOW_NET_PROBE"
	// A forwarded datagram reaches loopback in microseconds; this only has to
	// outlast scheduler noise before we conclude the packet was dropped.
	forwardWindow = 2 * time.Second
)

// guestTap is the test's end of the virtual link: write frames to inject
// guest traffic, read frames the gateway sends back.
type guestTap struct {
	conn   net.Conn
	frames chan []byte
}

// startNetwork builds the same virtual network gvproxy_create builds
// (buildTapConfig → virtualnetwork.New → installAllowNetHandlers) and
// attaches a test-driven guest link to it.
func startNetwork(t *testing.T, allowNet []string) *guestTap {
	t.Helper()

	cfg := testGvproxyConfig()
	cfg.AllowNet = allowNet
	return startNetworkWith(t, cfg)
}

// startNetworkWith is startNetwork's body, taking the whole config so a test can
// set cfg.RateLimit and exercise the shaper on the same path gvproxy_create
// uses. Note net.Pipe is synchronous and unbuffered: it can show pacing and RX
// queueing, but it cannot show the TX socket-buffer backpressure chain, because
// there is no buffer to fill.
func startNetworkWith(t *testing.T, cfg GvproxyConfig) *guestTap {
	t.Helper()
	return startNetworkWithSeams(t, cfg, networkSeams{})
}

// networkSeams carries what gvproxy_create fills from a box's secrets (the
// MITM slots) and the two seams that would otherwise reach the outside world:
// the host resolver and the socket dialer. Both default to refusing, so a
// test that forgets to script them fails fast instead of touching live DNS
// or the network.
type networkSeams struct {
	ca            *BoxCA
	secretMatcher *SecretHostMatcher
	resolve       resolveFunc
	dial          dialFunc
}

func refuseResolve(_ context.Context, host string) ([]net.IP, error) {
	return nil, fmt.Errorf("test harness: unscripted resolution of %q", host)
}

func refuseDial(_ context.Context, network, addr string) (net.Conn, error) {
	return nil, fmt.Errorf("test harness: unscripted dial of %s %s", network, addr)
}

// startNetworkWithSeams is startNetworkWith's body with the seams exposed. It
// mirrors gvproxy_create: buildTapConfig → virtualnetwork.New →
// installAllowNetHandlers with the same filter and dialer a box gets.
func startNetworkWithSeams(t *testing.T, cfg GvproxyConfig, seams networkSeams) *guestTap {
	t.Helper()

	if seams.resolve == nil {
		seams.resolve = refuseResolve
	}
	if seams.dial == nil {
		seams.dial = refuseDial
	}

	tapConfig := buildTapConfig(cfg, types.QemuProtocol)
	// Route the unlisted TEST-NET destination to a test-owned loopback
	// listener. The forwarders dial the NAT-translated address; the allowlist
	// still sees 198.51.100.9.
	tapConfig.NAT[unlistedIP] = "127.0.0.1"

	vn, err := virtualnetwork.New(tapConfig)
	if err != nil {
		t.Fatalf("virtualnetwork.New: %v", err)
	}

	var filter *AllowNetFilter
	if len(cfg.AllowNet) > 0 {
		filter = newAllowNetFilter(cfg)
	}
	// Same condition as production: secrets alone are reason enough to
	// replace the upstream forwarders.
	if len(cfg.AllowNet) > 0 || seams.secretMatcher != nil {
		dialer, err := newEgressDialer(filter, cfg.Subnet)
		if err != nil {
			t.Fatalf("newEgressDialer: %v", err)
		}
		dialer.resolve = seams.resolve
		dialer.dial = seams.dial
		if err := installAllowNetHandlers(vn, tapConfig, tapConfig.Ec2MetadataAccess, filter, dialer, seams.ca, seams.secretMatcher); err != nil {
			t.Fatalf("installAllowNetHandlers: %v", err)
		}
	}

	guestSide, stackSide := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = vn.AcceptQemu(ctx, wrapConn(stackSide, 4, cfg.RateLimit)) }()
	t.Cleanup(func() {
		cancel()
		_ = guestSide.Close()
	})

	tap := &guestTap{conn: guestSide, frames: make(chan []byte, 64)}
	// Drain the gateway→guest direction: the switch writes ARP requests and
	// replies synchronously over net.Pipe and would block without a reader.
	go tap.readLoop()
	return tap
}

func (g *guestTap) readLoop() {
	var size [4]byte
	for {
		if _, err := readFull(g.conn, size[:]); err != nil {
			return
		}
		frame := make([]byte, binary.BigEndian.Uint32(size[:]))
		if _, err := readFull(g.conn, frame); err != nil {
			return
		}
		if g.answerARP(frame) {
			continue
		}
		select {
		case g.frames <- frame:
		default: // capture buffer full: the tests only inspect DNS replies
		}
	}
}

// answerARP replies to the gateway's ARP request for the guest IP. Without
// it the stack has no link address for the guest and never delivers a reply
// packet, which a real guest's kernel would handle.
func (g *guestTap) answerARP(frame []byte) bool {
	if len(frame) < header.EthernetMinimumSize+header.ARPSize {
		return false
	}
	eth := header.Ethernet(frame)
	if eth.Type() != header.ARPProtocolNumber {
		return false
	}
	req := header.ARP(frame[header.EthernetMinimumSize:])
	if !req.IsValid() || req.Op() != header.ARPRequest {
		return false
	}
	cfg := testGvproxyConfig()
	guestIP := net.ParseIP(cfg.GuestIP).To4()
	if !net.IP(req.ProtocolAddressTarget()).Equal(guestIP) {
		return false
	}
	guestMAC, err := net.ParseMAC(cfg.GuestMac)
	if err != nil {
		return false
	}

	reply := make([]byte, header.EthernetMinimumSize+header.ARPSize)
	header.Ethernet(reply).Encode(&header.EthernetFields{
		SrcAddr: tcpip.LinkAddress(guestMAC),
		DstAddr: eth.SourceAddress(),
		Type:    header.ARPProtocolNumber,
	})
	arp := header.ARP(reply[header.EthernetMinimumSize:])
	arp.SetIPv4OverEthernet()
	arp.SetOp(header.ARPReply)
	copy(arp.HardwareAddressSender(), guestMAC)
	copy(arp.ProtocolAddressSender(), guestIP)
	copy(arp.HardwareAddressTarget(), req.HardwareAddressSender())
	copy(arp.ProtocolAddressTarget(), req.ProtocolAddressSender())

	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(reply)))
	_ = g.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = g.conn.Write(append(size[:], reply...))
	return true
}

func readFull(conn net.Conn, buf []byte) (int, error) {
	read := 0
	for read < len(buf) {
		n, err := conn.Read(buf[read:])
		read += n
		if err != nil {
			return read, err
		}
	}
	return read, nil
}

func (g *guestTap) send(t *testing.T, frame []byte) {
	t.Helper()
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(frame)))
	if err := g.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("SetWriteDeadline: %v", err)
	}
	if _, err := g.conn.Write(append(size[:], frame...)); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

// --- frame construction -----------------------------------------------------

func mac(t *testing.T, s string) tcpip.LinkAddress {
	t.Helper()
	parsed, err := net.ParseMAC(s)
	if err != nil {
		t.Fatalf("ParseMAC(%q): %v", s, err)
	}
	return tcpip.LinkAddress(parsed)
}

func addr(t *testing.T, s string) tcpip.Address {
	t.Helper()
	ip := net.ParseIP(s).To4()
	if ip == nil {
		t.Fatalf("not an IPv4 address: %q", s)
	}
	return tcpip.AddrFrom4Slice(ip)
}

// ipv4Frame wraps an already-checksummed transport segment in IPv4 +
// Ethernet, addressed to the gateway MAC so the switch delivers it to the
// stack (switch.go:281).
func ipv4Frame(t *testing.T, src, dst tcpip.Address, proto tcpip.TransportProtocolNumber, segment []byte) []byte {
	t.Helper()
	cfg := testGvproxyConfig()

	total := header.IPv4MinimumSize + len(segment)
	ip := header.IPv4(make([]byte, total))
	ip.Encode(&header.IPv4Fields{
		TotalLength: uint16(total),
		TTL:         64,
		Protocol:    uint8(proto),
		SrcAddr:     src,
		DstAddr:     dst,
	})
	ip.SetChecksum(^ip.CalculateChecksum())
	copy(ip[header.IPv4MinimumSize:], segment)

	frame := make([]byte, header.EthernetMinimumSize+total)
	header.Ethernet(frame).Encode(&header.EthernetFields{
		SrcAddr: mac(t, cfg.GuestMac),
		DstAddr: mac(t, cfg.GatewayMac),
		Type:    header.IPv4ProtocolNumber,
	})
	copy(frame[header.EthernetMinimumSize:], ip)
	return frame
}

func udpFrame(t *testing.T, dstIP string, dstPort uint16, payload []byte) []byte {
	t.Helper()
	cfg := testGvproxyConfig()
	src, dst := addr(t, cfg.GuestIP), addr(t, dstIP)

	length := header.UDPMinimumSize + len(payload)
	segment := header.UDP(make([]byte, length))
	segment.Encode(&header.UDPFields{
		SrcPort: guestSrcPort,
		DstPort: dstPort,
		Length:  uint16(length),
	})
	copy(segment.Payload(), payload)

	xsum := header.PseudoHeaderChecksum(udp.ProtocolNumber, src, dst, uint16(length))
	xsum = checksum.Checksum(payload, xsum)
	segment.SetChecksum(^segment.CalculateChecksum(xsum))

	return ipv4Frame(t, src, dst, udp.ProtocolNumber, segment)
}

func tcpSynFrame(t *testing.T, dstIP string, dstPort uint16) []byte {
	t.Helper()
	cfg := testGvproxyConfig()
	src, dst := addr(t, cfg.GuestIP), addr(t, dstIP)

	segment := header.TCP(make([]byte, header.TCPMinimumSize))
	segment.Encode(&header.TCPFields{
		SrcPort:    guestSrcPort,
		DstPort:    dstPort,
		SeqNum:     1000,
		DataOffset: header.TCPMinimumSize,
		Flags:      header.TCPFlagSyn,
		WindowSize: 65535,
	})
	xsum := header.PseudoHeaderChecksum(tcp.ProtocolNumber, src, dst, header.TCPMinimumSize)
	segment.SetChecksum(^segment.CalculateChecksum(xsum))

	return ipv4Frame(t, src, dst, tcp.ProtocolNumber, segment)
}

func listenUDP(t *testing.T) (*net.UDPConn, uint16) {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("ListenUDP: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn, uint16(conn.LocalAddr().(*net.UDPAddr).Port)
}

func listenTCP(t *testing.T) (net.Listener, uint16) {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return ln, uint16(ln.Addr().(*net.TCPAddr).Port)
}

// assertDatagramDropped fails unless the read deadline expires with nothing
// delivered. Only a timeout proves the filter dropped the datagram: any other
// read error (a closed socket, a bad deadline) would otherwise be mistaken for
// the policy working and turn every blocking test green for the wrong reason.
// probe describes the datagram that must not arrive.
func assertDatagramDropped(t *testing.T, conn *net.UDPConn, probeFormat string, probeArgs ...any) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	buf := make([]byte, 2048)
	n, from, err := conn.ReadFrom(buf)
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return // the deadline passed with no datagram, which is the contract
		}
		t.Fatalf("ReadFrom: %v", err)
	}
	t.Fatalf("%s was forwarded, arriving from %s: %q",
		fmt.Sprintf(probeFormat, probeArgs...), from, buf[:n])
}

// --- tests ------------------------------------------------------------------

// TestAllowNetBlocksUnlistedTCP is the control: it proves the allowlist is
// active and rejecting 198.51.100.9 on the transport that IS filtered.
// Without it, a UDP result could just mean a broken allow_net config.
func TestAllowNetBlocksUnlistedTCP(t *testing.T) {
	ln, port := listenTCP(t)
	tap := startNetwork(t, []string{allowedCIDR})

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			accepted <- conn
		}
	}()

	tap.send(t, tcpSynFrame(t, unlistedIP, port))

	select {
	case conn := <-accepted:
		_ = conn.Close()
		t.Fatalf("allow_net=%v: TCP to unlisted %s was forwarded to the host listener", allowedCIDR, unlistedIP)
	case <-time.After(forwardWindow):
	}
}

// TestAllowNetBlocksUnlistedUDP is the reproducer for the reported bypass:
// the same allowlist, the same unlisted destination, UDP instead of TCP.
func TestAllowNetBlocksUnlistedUDP(t *testing.T) {
	conn, port := listenUDP(t)
	tap := startNetwork(t, []string{allowedCIDR})

	tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))

	assertDatagramDropped(t, conn, "allow_net=%v: UDP to unlisted %s", allowedCIDR, unlistedIP)
}

// TestAllowNetBlocksHostAliasUDP is the reproducer for the host-alias bypass.
// 192.168.127.254 NATs to the host's loopback, so it is an egress destination
// like any other: a guest reaching it under a restrictive allowlist would put
// every service bound to host loopback outside the reach of allow_net.
func TestAllowNetBlocksHostAliasUDP(t *testing.T) {
	cfg := testGvproxyConfig()
	conn, port := listenUDP(t)
	tap := startNetwork(t, []string{allowedCIDR})

	tap.send(t, udpFrame(t, cfg.HostIP, port, []byte(probePayload)))

	assertDatagramDropped(t, conn, "allow_net=%v: UDP to host alias %s", allowedCIDR, cfg.HostIP)
}

// TestAllowNetBlocksHostAliasTCP is the TCP twin: the same allowlist, the same
// host alias destination, over the transport that carries SNI/Host.
func TestAllowNetBlocksHostAliasTCP(t *testing.T) {
	cfg := testGvproxyConfig()
	ln, port := listenTCP(t)
	tap := startNetwork(t, []string{allowedCIDR})

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			accepted <- conn
		}
	}()

	tap.send(t, tcpSynFrame(t, cfg.HostIP, port))

	select {
	case conn := <-accepted:
		_ = conn.Close()
		t.Fatalf("allow_net=%v: TCP to host alias %s was forwarded to host loopback",
			allowedCIDR, cfg.HostIP)
	case <-time.After(forwardWindow):
	}
}

// TestAllowNetForwardsListedHostAlias pins the other half of the contract:
// once the alias is listed, policy still matches the pre-NAT address while the
// forwarder dials the NAT-translated loopback, so the host stays reachable.
func TestAllowNetForwardsListedHostAlias(t *testing.T) {
	cfg := testGvproxyConfig()
	conn, udpPort := listenUDP(t)
	ln, tcpPort := listenTCP(t)
	tap := startNetwork(t, []string{cfg.HostIP})

	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()

	tap.send(t, udpFrame(t, cfg.HostIP, udpPort, []byte(probePayload)))
	if err := conn.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	buf := make([]byte, 2048)
	n, _, err := conn.ReadFrom(buf)
	if err != nil {
		t.Fatalf("a listed host alias must forward UDP, but the datagram was dropped: %v", err)
	}
	if string(buf[:n]) != probePayload {
		t.Fatalf("forwarded payload = %q, want %q", buf[:n], probePayload)
	}

	tap.send(t, tcpSynFrame(t, cfg.HostIP, tcpPort))
	select {
	case c := <-accepted:
		_ = c.Close()
	case <-time.After(forwardWindow):
		t.Fatal("a listed host alias must forward TCP to host loopback")
	}
}

// TestAllowNetHostnameRulesAlsoBindUDP: a hostname-only allowlist denies all
// UDP egress. UDP carries no SNI or Host header, so a hostname rule cannot be
// evaluated for it, and a datagram sent straight to a hard-coded address is
// how a guest would otherwise sidestep a rule it cannot present a name for.
//
// Both assertions here are negative, so neither can distinguish "policy is
// engaged" from "this tap forwards nothing at all". The affirmative side is
// TestEmptyAllowlistForwardsUDP and TestUnfilteredNetworkForwardsUnlistedTCP,
// which drive the same harness with no allowlist and require both transports
// to reach their listeners. The pairing lives at file level, not inside this
// test, as it does for the sibling TestAllowNetBlocksUnlisted{TCP,UDP}.
//
// A DNS probe used to stand in as the in-test control, back when allow_net
// sinkholed unlisted names. It cannot any more: DNS is unfiltered, so
// "blocked.test resolves" is true under every configuration and proves
// nothing. The TCP half is kept because it is the transport twin of the
// subject, on an ephemeral port where decideTCPRoute blocks outright rather
// than on 443/80 where the gateway would complete the handshake first.
func TestAllowNetHostnameRulesAlsoBindUDP(t *testing.T) {
	conn, port := listenUDP(t)
	ln, tcpPort := listenTCP(t)
	tap := startNetwork(t, []string{"example.com"})

	accepted := make(chan net.Conn, 1)
	go func() {
		if c, err := ln.Accept(); err == nil {
			accepted <- c
		}
	}()
	tap.send(t, tcpSynFrame(t, unlistedIP, tcpPort))
	select {
	case c := <-accepted:
		_ = c.Close()
		t.Fatalf("allow_net=[example.com]: TCP to hard-coded %s must be blocked", unlistedIP)
	case <-time.After(forwardWindow):
	}

	tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))
	assertDatagramDropped(t, conn, "allow_net=[example.com]: UDP to hard-coded %s", unlistedIP)
}

// TestStartupPerformsNoDNSLookups: nothing is resolved at box creation any
// more. A name is resolved when the guest asks for it or connects to it,
// never before — so a box with an unresolvable allow_net entry still starts,
// and creation does not wait on the host resolver.
func TestStartupPerformsNoDNSLookups(t *testing.T) {
	var lookups atomic.Int32
	counting := func(ctx context.Context, host string) ([]net.IP, error) {
		lookups.Add(1)
		return refuseResolve(ctx, host)
	}

	// Substituted before anything is built, so a lookup made while
	// constructing the filter or the dialer is counted too. Passing the seam
	// through networkSeams alone would not catch that: the harness assigns
	// dialer.resolve only after newEgressDialer has returned, so construction
	// would resolve through the untouched production path and the counter
	// would read zero however the code regressed.
	//
	// What this does not reach: gvproxy_create itself. The harness mirrors it
	// (startNetworkWithSeams) rather than calling it, so a resolution added
	// directly to gvproxy_create is outside what any test in this package
	// sees. The pieces it does build — newAllowNetFilter, newEgressDialer,
	// installAllowNetHandlers — are where such a resolution would naturally
	// go, and those are covered.
	restore := systemResolve
	systemResolve = counting
	t.Cleanup(func() { systemResolve = restore })

	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{"example.com", "*.example.net", "api.example.org:443"}
	startNetworkWithSeams(t, cfg, networkSeams{resolve: counting})

	if n := lookups.Load(); n != 0 {
		t.Fatalf("box creation performed %d DNS lookups; hostname rules must not be resolved at start", n)
	}
}

// TestEmptyAllowlistForwardsUDP guards the other direction: an empty
// allow_net is documented as full internet access, so the new UDP handler
// must not turn the default configuration into a blackhole.
func TestEmptyAllowlistForwardsUDP(t *testing.T) {
	conn, port := listenUDP(t)
	tap := startNetwork(t, nil)

	tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))

	if err := conn.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	buf := make([]byte, 2048)
	n, _, err := conn.ReadFrom(buf)
	if err != nil {
		t.Fatalf("empty allow_net must forward UDP, but the datagram was dropped: %v", err)
	}
	if string(buf[:n]) != probePayload {
		t.Fatalf("forwarded payload = %q, want %q", buf[:n], probePayload)
	}
}

// TestUnfilteredNetworkForwardsUnlistedTCP pins the consequence of
// main.go:437 logging an OverrideTCPHandler failure and continuing: the box
// keeps the upstream default handler, which forwards everything. It is the
// same network minus the override, so a failed override is a fully open box.
func TestUnfilteredNetworkForwardsUnlistedTCP(t *testing.T) {
	ln, port := listenTCP(t)
	tap := startNetwork(t, nil) // no allow_net → no OverrideTCPHandler call

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			accepted <- conn
		}
	}()

	tap.send(t, tcpSynFrame(t, unlistedIP, port))

	select {
	case conn := <-accepted:
		_ = conn.Close()
	case <-time.After(forwardWindow):
		t.Fatal("default handler did not forward TCP — harness is not delivering frames to the stack")
	}
}
