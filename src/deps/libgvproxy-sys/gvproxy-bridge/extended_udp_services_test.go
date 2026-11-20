package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/insomniacslk/dhcp/dhcpv4"
	"golang.org/x/net/dns/dnsmessage"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
)

func udpServiceConfig() GvproxyConfig {
	cfg := testGvproxyConfig()
	cfg.DNSZones = []DNSZone{{Name: "example.", DefaultIP: "192.0.2.31"}}
	return cfg
}

func udpDHCPDiscover(t *testing.T, cfg GvproxyConfig) *dhcpv4.DHCPv4 {
	t.Helper()
	hardware, err := net.ParseMAC(cfg.GuestMac)
	if err != nil {
		t.Fatal(err)
	}
	discover, err := dhcpv4.NewDiscovery(hardware, dhcpv4.WithBroadcast(true))
	if err != nil {
		t.Fatal(err)
	}
	return discover
}

func requireUDPServiceReplies(t *testing.T, tap *guestTap, cfg GvproxyConfig) {
	t.Helper()
	const queryID = 543
	tap.send(t, udpFrame(t, cfg.GatewayIP, 53, modeDNSQuery(t, queryID)))
	var dns dnsmessage.Message
	if err := dns.Unpack(readGuestUDP(t, tap, cfg.GatewayIP, 53, guestSrcPort)); err != nil {
		t.Fatal(err)
	}
	if dns.ID != queryID || !dns.Response || len(dns.Answers) != 1 {
		t.Fatalf("unexpected registered DNS reply: %+v", dns)
	}
	record, ok := dns.Answers[0].Body.(*dnsmessage.AResource)
	if !ok || record.A != [4]byte{192, 0, 2, 31} {
		t.Fatalf("unexpected registered DNS answer: %+v", dns.Answers[0])
	}

	discover := udpDHCPDiscover(t, cfg)
	tap.send(t, udpFrameFrom(t, "0.0.0.0", "255.255.255.255", 68, 67, discover.ToBytes()))
	requireDHCPOffer(t, tap, cfg, discover)
}

func requireDHCPOffer(t *testing.T, tap *guestTap, cfg GvproxyConfig, discover *dhcpv4.DHCPv4) {
	t.Helper()
	reply, err := dhcpv4.FromBytes(readGuestUDP(t, tap, cfg.GatewayIP, 67, 68))
	if err != nil {
		t.Fatal(err)
	}
	if reply.TransactionID != discover.TransactionID || reply.MessageType() != dhcpv4.MessageTypeOffer ||
		!reply.YourIPAddr.Equal(net.ParseIP(cfg.GuestIP)) {
		t.Fatalf("unexpected registered DHCP offer: %s", reply.Summary())
	}
}

func TestCloudDHCPScopePrecedesServiceDemux(t *testing.T) {
	t.Run("legacy", func(t *testing.T) { checkCloudDHCPScope(t, nil) })
	t.Run("extended", func(t *testing.T) { checkCloudDHCPScope(t, &trustedTCPRules{}) })
}

func checkCloudDHCPScope(t *testing.T, rules *trustedTCPRules) {
	t.Helper()
	const ordinary = "192.0.2.84"
	cfg := udpServiceConfig()
	tap := startNetworkWithSeams(t, cfg, networkSeams{cloud: true, tcp: rules})
	if guestUDPEndpoint(t, tap, ordinary, 68, 67) == nil {
		t.Fatal("expected real wildcard DHCP listener to match the unapproved destination")
	}
	requireUDPServiceReplies(t, tap, cfg)
	discover := udpDHCPDiscover(t, cfg)
	tap.send(t, udpFrameFrom(t, cfg.GuestIP, cfg.GatewayIP, 68, 67, discover.ToBytes()))
	requireDHCPOffer(t, tap, cfg, discover)

	for _, tc := range []struct {
		name        string
		destination string
		sourcePort  uint16
		fragmented  bool
	}{
		{name: "outside gateway", destination: ordinary, sourcePort: 68},
		{name: "unapproved source port", destination: cfg.GatewayIP, sourcePort: 69},
		{name: "fragmented outside gateway", destination: ordinary, sourcePort: 68, fragmented: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stats := tap.policy.stack.Stats()
			dropped := stats.IP.IPTablesInputDropped.Value()
			received := stats.UDP.PacketsReceived.Value()
			frame := udpFrameFrom(t, cfg.GuestIP, tc.destination, tc.sourcePort, 67, discover.ToBytes())
			if tc.fragmented {
				first, last := fragmentGuestDatagram(frame)
				tap.send(t, last)
				tap.send(t, first)
			} else {
				tap.send(t, frame)
			}
			requireUDPServiceReplies(t, tap, cfg)
			if got := stats.UDP.PacketsReceived.Value() - received; got != 2 {
				t.Errorf("UDP packet count = %d, want only the two valid service probes", got)
			}
			if got := stats.IP.IPTablesInputDropped.Value() - dropped; got != 1 {
				t.Errorf("pre-demux drops = %d, want 1", got)
			}
		})
	}

	discover = udpDHCPDiscover(t, cfg)
	first, last := fragmentGuestDatagram(udpFrameFrom(t, cfg.GuestIP, cfg.GatewayIP, 68, 67, discover.ToBytes()))
	tap.send(t, last)
	tap.send(t, first)
	requireDHCPOffer(t, tap, cfg, discover)
}

func fragmentGuestDatagram(frame []byte) ([]byte, []byte) {
	const headerLength = header.EthernetMinimumSize + header.IPv4MinimumSize
	// Preserve the UDP header and checksum in the first fragment.
	fragOffset := uint16(header.UDPMinimumSize)
	first := append([]byte(nil), frame[:headerLength+int(fragOffset)]...)
	last := append(append([]byte(nil), frame[:headerLength]...), frame[headerLength+int(fragOffset):]...)
	update := func(packet []byte, flags uint8, offset uint16) {
		ip := header.IPv4(packet[header.EthernetMinimumSize:])
		ip.SetID(1234)
		ip.SetFlagsFragmentOffset(flags, offset)
		ip.SetTotalLength(uint16(len(ip)))
		ip.SetChecksum(0)
		ip.SetChecksum(^ip.CalculateChecksum())
	}
	update(first, header.IPv4FlagMoreFragments, 0)
	update(last, 0, fragOffset)
	return first, last
}

func closeDHCPTestEndpoint(t *testing.T, tap *guestTap, original string) {
	t.Helper()
	// The pinned service binds wildcard IPv4. Close exactly this endpoint to
	// create the same-port miss while keeping the real stack and forwarding.
	endpoint, ok := guestUDPEndpoint(t, tap, original, guestSrcPort, 67).(tcpip.Endpoint)
	if !ok {
		t.Fatal("expected the wildcard DHCP endpoint to match unicast")
	}
	endpoint.Close()
	if guestUDPEndpoint(t, tap, original, guestSrcPort, 67) != nil {
		t.Fatal("expected a demux miss after closing only the DHCP endpoint")
	}
}

func TestExtendedUDPRegisteredServicesAndSamePortMisses(t *testing.T) {
	const ordinary = "192.0.2.84"
	cfg := udpServiceConfig()
	for _, tt := range []struct {
		name  string
		rules trustedTCPRules
		deny  bool
	}{
		{name: "unmatched port controls"},
		{name: "registered services and denied default admission",
			rules: trustedTCPRules{deny: []string{"0.0.0.0/0"}}, deny: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			target, _ := newUDPTestTarget(t)
			tap := startNetworkWithSeams(t, cfg, networkSeams{tcp: &tt.rules, dial: target.dial})
			requireUDPServiceReplies(t, tap, cfg)
			if target.dials.Load() != 0 {
				t.Fatal("registered service traffic reached the default UDP dialer")
			}
			if tt.deny {
				assertUDPPolicyDrop(t, tap, target, cfg.GatewayIP, guestSrcPort, 54, outboundUserDeny)
			}
			closeDHCPTestEndpoint(t, tap, ordinary)
			for _, port := range []uint16{53, 67} {
				if guestUDPEndpoint(t, tap, ordinary, guestSrcPort, port) != nil {
					t.Fatalf("unicast probe to port %d matched an endpoint", port)
				}
				if tt.deny {
					assertUDPPolicyDrop(t, tap, target, ordinary, guestSrcPort, port, outboundUserDeny)
					continue
				}
				tap.send(t, udpFrame(t, ordinary, port, []byte("unicast control")))
				target.echo(t, tap, ordinary, guestSrcPort, port, "unicast control")
				target.requireDial(t, ordinary, port)
			}
		})
	}
}

func TestExtendedUDPWireProtection(t *testing.T) {
	const deniedPort = 8080
	target, port := newUDPTestTarget(t)
	rules := trustedTCPRules{deny: []string{unlistedIP + ":8080"}}
	cfg := testGvproxyConfig()
	tap := startNetworkWithSeams(t, cfg, networkSeams{tcp: &rules, dial: target.dial})
	previous := cfg.OutboundRevision
	for _, mode := range []string{"enabled", "disabled", "enabled"} {
		revision, err := newOutboundRevision()
		if err != nil {
			t.Fatal(err)
		}
		if err := tap.policy.replaceTrustedTCP(mode, rules, previous, revision); err != nil {
			t.Fatal(err)
		}
		before := tap.policy.active.Load()
		for _, path := range []string{"/network/outbound", outboundSnapshotPath} {
			request := httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{"mode":"enabled"}`))
			if path == outboundSnapshotPath {
				request.Header.Set("If-Match", outboundETag(revision))
				request.Header.Set(outboundRevisionHeader, "wire-next")
			}
			response := httptest.NewRecorder()
			tap.policy.ServeHTTP(response, request)
			if response.Code != http.StatusConflict || tap.policy.active.Load() != before {
				t.Fatalf("%s in mode %s changed trusted policy: %d %s", path, mode, response.Code, response.Body)
			}
		}
		previous = revision
	}
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("after wire conflicts")))
	target.echo(t, tap, unlistedIP, guestSrcPort, port, "after wire conflicts")
	target.requireDial(t, "127.0.0.1", port)
	assertUDPPolicyDrop(t, tap, target, unlistedIP, guestSrcPort, deniedPort, outboundUserDeny)
}

func TestExtendedUDPModeGatesServicesAndOrdinaryTraffic(t *testing.T) {
	for _, operation := range []string{"disable", "enable"} {
		for _, mode := range []string{"pending", "failed"} {
			t.Run(operation+"-"+mode, func(t *testing.T) {
				cfg := udpServiceConfig()
				target, port := newUDPTestTarget(t)
				rules := trustedTCPRules{}
				tap := startNetworkWithSeams(t, cfg, networkSeams{tcp: &rules, dial: target.dial})
				requireUDPServiceReplies(t, tap, cfg)
				tap.send(t, udpFrame(t, unlistedIP, port, []byte("initial enabled flow")))
				target.echo(t, tap, unlistedIP, guestSrcPort, port, "initial enabled flow")
				target.requireDial(t, "127.0.0.1", port)

				previous, wanted := cfg.OutboundRevision, "disabled"
				if operation == "enable" {
					if err := tap.policy.replaceTrustedTCP("disabled", rules, previous, "prepared-disabled"); err != nil {
						t.Fatal(err)
					}
					previous, wanted = "prepared-disabled", "enabled"
				}
				if mode == "pending" {
					paused := &pausedNICOperations{nicOperations: tap.policy.stack,
						entered: make(chan string, 1), resume: make(chan struct{})}
					release := sync.OnceFunc(func() { close(paused.resume) })
					t.Cleanup(release)
					tap.policy.nicOps = paused
					done := make(chan error, 1)
					go func() { done <- tap.policy.replaceTrustedTCP(wanted, rules, previous, "udp-transition") }()
					select {
					case got := <-paused.entered:
						if got != operation {
							t.Fatalf("NIC operation %q, want %q", got, operation)
						}
					case <-time.After(forwardWindow):
						t.Fatal("NIC operation did not become pending")
					}
					requireUDPModeDrop(t, tap, cfg, target, port)
					release()
					if err := <-done; err != nil {
						t.Fatal(err)
					}
				} else {
					if operation == "disable" {
						tap.policy.nicOps = failedTCPDisable{tap.policy.stack}
					} else {
						tap.policy.nicOps = failedTCPEnable{tap.policy.stack}
					}
					if err := tap.policy.replaceTrustedTCP(wanted, rules, previous, "udp-transition"); err == nil {
						t.Fatal("NIC operation unexpectedly succeeded")
					}
					requireUDPModeDrop(t, tap, cfg, target, port)
				}

				tap.policy.nicOps = tap.policy.stack
				revision := tap.policy.active.Load().revision
				if err := tap.policy.replaceTrustedTCP("enabled", rules, revision, "udp-resumed"); err != nil {
					t.Fatal(err)
				}
				requireUDPServiceReplies(t, tap, cfg)
				tap.send(t, udpFrame(t, unlistedIP, port, []byte("resumed UDP")))
				target.echo(t, tap, unlistedIP, guestSrcPort, port, "resumed UDP")
			})
		}
	}
}

func requireUDPModeDrop(t *testing.T, tap *guestTap, cfg GvproxyConfig, target *udpTestTarget, port uint16) {
	t.Helper()
	packets := tap.policy.stack.Stats().UDP.PacketsReceived.Value()
	dials := target.dials.Load()
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("established tuple")))
	tap.send(t, udpFrameFrom(t, cfg.GuestIP, unlistedIP, guestSrcPort+1, port, []byte("new tuple")))
	tap.send(t, udpFrame(t, cfg.GatewayIP, 53, modeDNSQuery(t, 544)))
	tap.send(t, udpFrameFrom(t, "0.0.0.0", "255.255.255.255", 68, 67, udpDHCPDiscover(t, cfg).ToBytes()))
	assertDatagramDropped(t, target.conn, "UDP during disabled transition")
	if got := tap.policy.stack.Stats().UDP.PacketsReceived.Value(); got != packets || target.dials.Load() != dials {
		t.Fatalf("gated traffic reached a registered UDP endpoint or dialer: received %d packets and %d dials", got-packets, target.dials.Load()-dials)
	}
	for len(tap.frames) != 0 {
		frame := <-tap.frames
		_, dns := guestUDPPayload(frame, cfg.GatewayIP, 53, guestSrcPort)
		_, dhcp := guestUDPPayload(frame, cfg.GatewayIP, 67, 68)
		if dns || dhcp {
			t.Fatal("registered service replied during disabled transition")
		}
	}
}
