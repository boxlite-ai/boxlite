package main

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	logrus "github.com/sirupsen/logrus"
	logrustest "github.com/sirupsen/logrus/hooks/test"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

type udpTestTarget struct {
	conn  *net.UDPConn
	calls chan string
	dials atomic.Uint64
}

func newUDPTestTarget(t *testing.T) (*udpTestTarget, uint16) {
	t.Helper()
	conn, port := listenUDP(t)
	return &udpTestTarget{conn: conn, calls: make(chan string, maxExtendedUDPFlows+1)}, port
}

// All approved and unexpected dial attempts go to the same test-owned sink.
func (target *udpTestTarget) dial(ctx context.Context, network, address string) (net.Conn, error) {
	target.dials.Add(1)
	target.calls <- network + " " + address
	return (&net.Dialer{}).DialContext(ctx, network, target.conn.LocalAddr().String())
}

func (target *udpTestTarget) requireDial(t *testing.T, ip string, port uint16) {
	t.Helper()
	want := "udp4 " + net.JoinHostPort(ip, strconv.Itoa(int(port)))
	select {
	case got := <-target.calls:
		if got != want {
			t.Fatalf("dial = %q, want %q", got, want)
		}
	case <-time.After(forwardWindow):
		t.Fatalf("no dial to %s", want)
	}
}

func (target *udpTestTarget) receive(t *testing.T, payload string) *net.UDPAddr {
	t.Helper()
	if err := target.conn.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatal(err)
	}
	var buffer [2048]byte
	n, source, err := target.conn.ReadFromUDP(buffer[:])
	if err != nil || string(buffer[:n]) != payload {
		t.Fatalf("target received %q, err=%v, want %q", buffer[:n], err, payload)
	}
	return source
}

func (target *udpTestTarget) echo(t *testing.T, tap *guestTap, original string, sourcePort, destPort uint16, payload string) {
	t.Helper()
	source := target.receive(t, payload)
	if _, err := target.conn.WriteToUDP([]byte(payload), source); err != nil {
		t.Fatal(err)
	}
	if got := readGuestUDP(t, tap, original, destPort, sourcePort); string(got) != payload {
		t.Fatalf("guest received %q, want %q", got, payload)
	}
}

func guestUDPPayload(frame []byte, from string, sourcePort, destPort uint16) ([]byte, bool) {
	if len(frame) < header.EthernetMinimumSize+header.IPv4MinimumSize+header.UDPMinimumSize ||
		header.Ethernet(frame).Type() != header.IPv4ProtocolNumber {
		return nil, false
	}
	ip := header.IPv4(frame[header.EthernetMinimumSize:])
	if ip.TransportProtocol() != udp.ProtocolNumber || ip.SourceAddress().String() != from {
		return nil, false
	}
	packet := header.UDP(ip.Payload())
	if len(packet) < header.UDPMinimumSize || packet.SourcePort() != sourcePort || packet.DestinationPort() != destPort {
		return nil, false
	}
	return packet.Payload(), true
}

func readGuestUDP(t *testing.T, tap *guestTap, from string, sourcePort, destPort uint16) []byte {
	t.Helper()
	deadline := time.After(forwardWindow)
	for {
		select {
		case frame := <-tap.frames:
			if payload, ok := guestUDPPayload(frame, from, sourcePort, destPort); ok {
				return payload
			}
		case <-deadline:
			t.Fatalf("guest received no UDP reply from %s:%d for port %d", from, sourcePort, destPort)
		}
	}
}

func guestUDPEndpoint(t *testing.T, tap *guestTap, original string, sourcePort, destPort uint16) stack.TransportEndpoint {
	t.Helper()
	return tap.policy.stack.FindTransportEndpoint(header.IPv4ProtocolNumber, udp.ProtocolNumber, stack.TransportEndpointID{
		LocalAddress: addr(t, original), LocalPort: destPort,
		RemoteAddress: addr(t, testGvproxyConfig().GuestIP), RemotePort: sourcePort,
	}, tap.policy.nic)
}

func waitUDPCondition(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.NewTimer(forwardWindow)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for !condition() {
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatalf("timed out waiting for %s", description)
		}
	}
}

func assertUDPPolicyDrop(t *testing.T, tap *guestTap, target *udpTestTarget, ip string, sourcePort, destPort uint16, reason outboundReason) {
	t.Helper()
	log := logrustest.NewLocal(logrus.StandardLogger())
	dials := target.dials.Load()
	packets := tap.policy.stack.Stats().UDP.PacketsReceived.Value()
	tap.send(t, udpFrameFrom(t, testGvproxyConfig().GuestIP, ip, sourcePort, destPort, []byte("denied probe")))
	waitUDPCondition(t, "denied datagram at default admission", func() bool {
		for _, entry := range log.AllEntries() {
			if entry.Data["reason"] == reason && entry.Data["dst_port"] == destPort {
				return true
			}
		}
		return false
	})
	if guestUDPEndpoint(t, tap, ip, sourcePort, destPort) != nil ||
		tap.policy.stack.Stats().UDP.PacketsReceived.Value() != packets || target.dials.Load() != dials {
		t.Fatalf("denied tuple %s:%d reached an endpoint or the dial hook", ip, destPort)
	}
	assertDatagramDropped(t, target.conn, "denied tuple %s:%d", ip, destPort)
	for len(tap.frames) != 0 {
		if _, ok := guestUDPPayload(<-tap.frames, ip, destPort, sourcePort); ok {
			t.Fatalf("guest received a UDP reply for denied tuple %s:%d", ip, destPort)
		}
	}
}

func TestExtendedUDPOriginalAndTranslatedDestinations(t *testing.T) {
	const (
		ordinary = "192.0.2.254"
		public   = "203.0.113.8"
		private  = "10.23.4.5"
		link     = "169.254.42.7"
		port     = 8080
	)
	for _, tt := range []struct {
		name, original, translated string
		rules                      trustedTCPRules
		reason                     outboundReason
	}{
		{name: "Local exact loopback", original: ordinary, translated: "127.0.0.1", rules: trustedTCPRules{allow: []string{ordinary + ":8080"}}},
		{name: "Local empty allowed control", original: ordinary, translated: public},
		{name: "Local forbidden original only", original: link, translated: public, reason: outboundPlatformDeny},
		{name: "Local forbidden translation only", original: ordinary, translated: link, reason: outboundPlatformDeny},
		{name: "Cloud empty allowed control", original: ordinary, translated: public, rules: trustedTCPRules{cloud: true}},
		{name: "Cloud private original only", original: private, translated: public, rules: trustedTCPRules{cloud: true}, reason: outboundPlatformDeny},
		{name: "Cloud loopback translation only", original: ordinary, translated: "127.0.0.1", rules: trustedTCPRules{cloud: true}, reason: outboundPlatformDeny},
		{name: "Pre NAT user deny", original: ordinary, translated: public, rules: trustedTCPRules{deny: []string{ordinary + ":8080"}}, reason: outboundUserDeny},
		{name: "CIDR matched at actual port", original: ordinary, translated: public, rules: trustedTCPRules{allow: []string{"192.0.2.0/24:8080"}}},
		{name: "Port restriction", original: ordinary, translated: public, rules: trustedTCPRules{allow: []string{"192.0.2.0/24:8081"}}, reason: outboundAllowMiss},
		{name: "Hostname allow alone", original: ordinary, translated: public, rules: trustedTCPRules{allow: []string{"allow.example:8080"}}, reason: outboundAllowMiss},
		{name: "Hostname deny matches port", original: ordinary, translated: public, rules: trustedTCPRules{
			allow: []string{ordinary}, deny: []string{"blocked.example:8080"},
		}, reason: outboundHostnameRequired},
		{name: "Hostname deny misses port", original: ordinary, translated: public, rules: trustedTCPRules{
			allow: []string{ordinary}, deny: []string{"blocked.example:8081"},
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			target, _ := newUDPTestTarget(t)
			tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{
				tcp: &tt.rules, nat: map[string]string{tt.original: tt.translated}, dial: target.dial,
			})
			if tt.reason != "" {
				assertUDPPolicyDrop(t, tap, target, tt.original, guestSrcPort, port, tt.reason)
				return
			}
			for _, payload := range []string{"checked UDP", ""} {
				tap.send(t, udpFrame(t, tt.original, port, []byte(payload)))
				target.echo(t, tap, tt.original, guestSrcPort, port, payload)
			}
			target.requireDial(t, tt.translated, port)
			if target.dials.Load() != 1 {
				t.Fatalf("dialed %d sockets for one tuple", target.dials.Load())
			}
		})
	}
}

func TestExtendedUDPDenyOnlyAllowsUnmatchedPort(t *testing.T) {
	target, port := newUDPTestTarget(t)
	const denied = 8080
	if port == denied {
		t.Fatal("test sink must have a different port than the denied tuple")
	}
	tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{
		tcp:  &trustedTCPRules{deny: []string{fmt.Sprintf("%s:%d", unlistedIP, denied)}},
		dial: target.dial,
	})
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("unmatched")))
	target.echo(t, tap, unlistedIP, guestSrcPort, port, "unmatched")
	target.requireDial(t, "127.0.0.1", port)
	assertUDPPolicyDrop(t, tap, target, unlistedIP, guestSrcPort, denied, outboundUserDeny)
}

func TestExtendedUDPEmptyTrustedSnapshotChecksBothAddresses(t *testing.T) {
	const (
		direct             = "192.0.2.81"
		originalAllowed    = "192.0.2.82"
		originalTranslated = "192.0.2.83"
		checkedLiteral     = "203.0.113.82"
		port               = 8080
	)
	for _, tt := range []struct {
		name, deniedOriginal, deniedLiteral string
		cloud                               bool
	}{
		{name: "Local", deniedOriginal: "169.254.42.7", deniedLiteral: "169.254.42.8"},
		{name: "Cloud", cloud: true, deniedOriginal: "10.23.4.5", deniedLiteral: "127.0.0.1"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			target, _ := newUDPTestTarget(t)
			tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{
				tcp: &trustedTCPRules{cloud: tt.cloud}, dial: target.dial,
				nat: map[string]string{
					tt.deniedOriginal: checkedLiteral, originalAllowed: checkedLiteral,
					originalTranslated: tt.deniedLiteral,
				},
			})
			snapshot := tap.policy.active.Load()
			tap.send(t, udpFrame(t, direct, port, []byte("direct control")))
			target.echo(t, tap, direct, guestSrcPort, port, "direct control")
			target.requireDial(t, direct, port)
			tap.send(t, udpFrame(t, originalAllowed, port, []byte("translation control")))
			target.echo(t, tap, originalAllowed, guestSrcPort, port, "translation control")
			target.requireDial(t, checkedLiteral, port)
			assertUDPPolicyDrop(t, tap, target, tt.deniedOriginal, guestSrcPort, port, outboundPlatformDeny)
			assertUDPPolicyDrop(t, tap, target, originalTranslated, guestSrcPort, port, outboundPlatformDeny)
			if tap.policy.active.Load() != snapshot || target.dials.Load() != 2 {
				t.Fatal("the guest cases must share the same empty trusted snapshot and only two positive dials")
			}
		})
	}
}
