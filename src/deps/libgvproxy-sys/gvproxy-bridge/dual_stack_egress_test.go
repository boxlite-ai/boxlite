package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"gvisor.dev/gvisor/pkg/tcpip/checksum"
	"gvisor.dev/gvisor/pkg/tcpip/header"
)

func TestDualStackGuestReadiness(t *testing.T) {
	config := optInIPv6(t)
	plan := ipv6LinkPlan{
		Interface: "eth0",
		Guest:     netip.MustParseAddr("fd12:3456:789a:1::2"),
		Gateway:   config.ipv6Gateway.Addr(),
	}
	config.OutboundRevision = "test-launch"
	complete := completeOutboundSnapshot{
		Policy:    completeOutboundPolicy{Mode: "enabled", AllowNet: []string{}, DenyNet: []string{}},
		Admission: dualStackAdmission, Revision: config.OutboundRevision, IPv6: &plan,
	}
	initial, _, err := complete.prepare(false)
	if err != nil {
		t.Fatal(err)
	}
	link := openIPv6TestLink(t, types.QemuProtocol, config, initial, nil)
	gateway := linkIPv6(plan.Gateway.String())
	guest := linkIPv6(plan.Guest.String())

	// Only DAD can traverse the enabled link before Guest confirmation.
	link.dad(t, gateway)
	link.receive(t, header.ICMPv6NeighborAdvert)
	echo := make(header.ICMPv6, header.ICMPv6EchoMinimumSize)
	echo.SetType(header.ICMPv6EchoRequest)
	frame := icmp6Frame(link.guestMAC, link.gatewayMAC, guest, gateway, echo)
	link.send(t, frame)
	link.noWrite(t)

	readiness := func() ipv6Readiness {
		t.Helper()
		proof := httptest.NewRecorder()
		link.policy.serveIPv6Readiness(proof, httptest.NewRequest(http.MethodGet, ipv6ReadinessPath, nil))
		var challenge ipv6Readiness
		if proof.Code != http.StatusOK || json.Unmarshal(proof.Body.Bytes(), &challenge) != nil {
			t.Fatalf("challenge failed: %d %s", proof.Code, proof.Body.String())
		}
		return challenge
	}
	confirm := func(proof ipv6Readiness, expect int) {
		t.Helper()
		body, err := json.Marshal(proof)
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		link.policy.serveIPv6Readiness(response, httptest.NewRequest(http.MethodPost, ipv6ReadinessPath, bytes.NewReader(body)))
		if response.Code != expect {
			t.Fatalf("confirmation returned %d, want %d: %s", response.Code, expect, response.Body.String())
		}
	}
	proof := readiness()
	wrong := proof
	wrong.Plan.Guest = netip.MustParseAddr("fd12:3456:789a:1::9")
	confirm(wrong, http.StatusConflict)
	link.send(t, frame)
	link.noWrite(t)
	confirm(proof, http.StatusNoContent)
	confirm(proof, http.StatusConflict)
	checkEcho := func() {
		t.Helper()
		group := header.SolicitedNodeAddr(gateway)
		multicast := header.EthernetAddressFromMulticastIPv6Address(group)
		link.send(t, icmp6Frame(link.guestMAC, multicast, guest, group, solicitation(gateway, link.guestMAC)))
		link.receive(t, header.ICMPv6NeighborAdvert)
		link.echo(t, guest, gateway)
	}
	checkEcho()

	replace := func(revision, mode string) error {
		complete.Revision, complete.Policy.Mode = revision, mode
		candidate, _, err := complete.prepare(false)
		if err != nil {
			return err
		}
		link.policy.mu.Lock()
		defer link.policy.mu.Unlock()
		return link.policy.apply(candidate, revision)
	}
	if err := replace("test-disabled", "disabled"); err != nil {
		t.Fatal(err)
	}
	link.dad(t, gateway)
	link.noWrite(t)
	confirm(proof, http.StatusConflict)
	if err := replace("test-enabled", "enabled"); err == nil {
		t.Fatal("enable accepted without current Guest confirmation")
	}
	confirm(readiness(), http.StatusNoContent)
	link.send(t, frame)
	link.noWrite(t)
	if err := replace("test-enabled", "enabled"); err != nil {
		t.Fatal(err)
	}
	checkEcho()
}

func TestDualStackLookupKeepsFinishedFamily(t *testing.T) {
	cases := []struct {
		stalled string
		want    net.IP
	}{
		{"ip4", net.ParseIP("2606:4700::1111")},
		{"ip6", net.ParseIP("1.1.1.1")},
	}
	for _, tc := range cases {
		t.Run(tc.stalled, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 600*time.Millisecond)
			defer cancel()
			canceled := make(chan error, 1)
			dialer := &egressDialer{
				nativeReady: func() bool { return true },
				resolveFamily: func(ctx context.Context, family, _ string) ([]net.IP, error) {
					if family == tc.stalled {
						<-ctx.Done()
						canceled <- ctx.Err()
						return nil, ctx.Err()
					}
					return []net.IP{tc.want}, nil
				},
			}
			got, err := dialer.lookup(ctx, "example.org")
			if err != nil || len(got) != 1 || !got[0].Equal(tc.want) || ctx.Err() != nil {
				t.Fatalf("lookup did not preserve the completed family and caller budget: %v %v", got, err)
			}
			select {
			case err := <-canceled:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("DNS cancellation: %v", err)
				}
			case <-ctx.Done():
				t.Fatal("stalled lookup did not stop at its own deadline")
			}
		})
	}
}

func TestDualStackTCPReservesAlternateFamilyTime(t *testing.T) {
	var attempts []string
	ctx, cancel := context.WithTimeout(t.Context(), 800*time.Millisecond)
	defer cancel()
	dialer := &egressDialer{
		nativeReady: func() bool { return true },
		resolveFamily: func(_ context.Context, family, _ string) ([]net.IP, error) {
			if family == "ip6" {
				return []net.IP{net.ParseIP("2606:4700::1111"), net.ParseIP("2606:4700::1001")}, nil
			}
			return []net.IP{net.ParseIP("1.1.1.1")}, nil
		},
		dial: func(ctx context.Context, network, destination string) (net.Conn, error) {
			attempts = append(attempts, network+" "+destination)
			if network == "tcp6" {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			left, right := net.Pipe()
			t.Cleanup(func() { _ = right.Close() })
			return left, nil
		},
	}
	conn, err := dialer.dialHost(ctx, egressTarget{Hostname: "example.org", Port: 443},
		func(netip.Addr) outboundReason { return outboundAllowed })
	if err != nil || ctx.Err() != nil {
		t.Fatalf("alternate family failed under short deadline: %v, %v", attempts, err)
	}
	_ = conn.Close()
	want := []string{"tcp6 [2606:4700::1111]:443", "tcp4 1.1.1.1:443"}
	if len(attempts) != len(want) || attempts[0] != want[0] || attempts[1] != want[1] {
		t.Fatalf("socket attempts %v, want %v", attempts, want)
	}
}

func TestDualStackGuestUDPUsesCheckedNativeSocket(t *testing.T) {
	listener, err := net.ListenUDP("udp6", &net.UDPAddr{IP: net.IPv6loopback})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := uint16(listener.LocalAddr().(*net.UDPAddr).Port)
	const allowed = "2606:4700::1111"
	config := optInIPv6(t)
	plan := ipv6LinkPlan{Interface: "eth0", Guest: netip.MustParseAddr("fd12:3456:789a:1::2"), Gateway: config.ipv6Gateway.Addr()}
	config.OutboundRevision = "test-udp"
	complete := completeOutboundSnapshot{
		Policy: completeOutboundPolicy{
			Mode:     "enabled",
			AllowNet: []string{netip.AddrPortFrom(netip.MustParseAddr(allowed), port).String()},
			DenyNet:  []string{},
		},
		Admission: dualStackAdmission, Revision: config.OutboundRevision, IPv6: &plan,
	}
	initial, _, err := complete.prepare(false)
	if err != nil {
		t.Fatal(err)
	}
	link := openIPv6TestLink(t, types.QemuProtocol, config, initial, nil)
	gateway, guest := linkIPv6(plan.Gateway.String()), linkIPv6(plan.Guest.String())
	address := linkIPv6(allowed)
	payload := []byte("v6-policy")
	frameTo := func(targetPort uint16, targetMAC string) []byte {
		body := make(header.UDP, header.UDPMinimumSize+len(payload))
		copy(body.Payload(), payload)
		body.Encode(&header.UDPFields{SrcPort: 25000, DstPort: targetPort, Length: uint16(len(body))})
		pseudo := header.PseudoHeaderChecksum(header.UDPProtocolNumber, guest, address, uint16(len(body)))
		body.SetChecksum(^body.CalculateChecksum(checksum.Checksum(payload, pseudo)))
		return ipv6Frame(mac(t, targetMAC), link.gatewayMAC, guest, address, header.UDPProtocolNumber, body)
	}
	attempts := make(chan string, 8)
	link.policy.active.Load().dialer.dial = func(ctx context.Context, network, destination string) (net.Conn, error) {
		attempts <- network + " " + destination
		return (&net.Dialer{}).DialContext(ctx, network, listener.LocalAddr().String())
	}
	link.send(t, frameTo(port, config.GuestMac))
	link.dad(t, gateway)
	link.receive(t, header.ICMPv6NeighborAdvert)
	select {
	case attempt := <-attempts:
		t.Fatalf("socket attempt before confirmation: %s", attempt)
	default:
	}
	challenge := httptest.NewRecorder()
	link.policy.serveIPv6Readiness(challenge, httptest.NewRequest(http.MethodGet, ipv6ReadinessPath, nil))
	confirmation := httptest.NewRecorder()
	link.policy.serveIPv6Readiness(confirmation, httptest.NewRequest(http.MethodPost, ipv6ReadinessPath, bytes.NewReader(challenge.Body.Bytes())))
	if confirmation.Code != http.StatusNoContent {
		t.Fatalf("confirmation returned %d: %s", confirmation.Code, confirmation.Body.String())
	}
	link.send(t, frameTo(port, "02:60:50:40:30:20"))
	link.send(t, frameTo(port^1, config.GuestMac))
	link.send(t, frameTo(port, config.GuestMac))
	if err := listener.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var packet [64]byte
	count, peer, err := listener.ReadFromUDP(packet[:])
	if err != nil || !bytes.Equal(packet[:count], payload) || peer.IP.To4() != nil {
		t.Fatalf("native UDP peer or data: %v %q %v", peer, packet[:count], err)
	}
	want := "udp6 " + netip.AddrPortFrom(netip.MustParseAddr(allowed), port).String()
	select {
	case attempt := <-attempts:
		if attempt != want {
			t.Fatalf("socket attempt %q, want %q", attempt, want)
		}
	default:
		t.Fatal("no admitted socket attempt")
	}
	select {
	case attempt := <-attempts:
		t.Fatalf("additional socket attempt: %s", attempt)
	default:
	}
}
