package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

func TestManagedNetworkReportsBusinessProxyFailureOnInstalledRoute(t *testing.T) {
	var dials int
	var route *proxyDNSResolver
	tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{beforeAttach: func(ctx context.Context, p *outboundPolicyController) {
		route = &proxyDNSResolver{
			work:    newDNSLookupWork(ctx),
			binding: &managedProxyBinding{RegistrationID: "fixture-proxy", RegistrationRevision: "1", Epoch: "fixture-epoch"},
			connect: mustProxyConnector(t, proxyTestConfig("http"), func(ctx context.Context, network, addr string) (net.Conn, error) {
				dials++
				return refuseDial(ctx, network, addr)
			}),
		}
		gateway, err := p.installManagedNetwork(ctx, route.work, route, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(gateway.server.close)
	}})
	readStatus := func() map[string]any {
		t.Helper()
		response := httptest.NewRecorder()
		tap.policy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, outboundStatusPath, nil))
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusOK {
			t.Fatalf("status %d: %s (error %v)", response.Code, response.Body, err)
		}
		return body
	}
	if status := readStatus(); status["proxy_diagnostic"] != nil {
		t.Fatalf("new installation already has a diagnostic: %v", status)
	}
	old := tap.policy.active.Load()
	target := proxyTestTarget(proxyTestFirstIP)
	conn, err := old.dialer.byAddress(target)(context.Background())
	requireProxyFailure(t, conn, err, proxyUnreachable)
	if status := readStatus(); status["proxy_diagnostic"] != "proxy_unreachable" || dials != 1 {
		t.Fatalf("refused proxy dial did not publish a diagnostic: %v, dials %d", status, dials)
	}
	target.Port = 0
	conn, err = old.dialer.byAddress(target)(context.Background())
	requireProxyFailure(t, conn, err, proxyHandshakeFailed)
	if status := readStatus(); status["proxy_diagnostic"] != "proxy_unreachable" || dials != 1 {
		t.Fatalf("local policy refusal changed the diagnostic: %v, dials %d", status, dials)
	}
	if err := replaceManagedRouteForTest(tap.policy, context.Background(), outboundPolicy{Mode: "enabled"}, "replacement", route); err != nil {
		t.Fatal(err)
	}
	conn, err = old.dialer.byAddress(proxyTestTarget(proxyTestFirstIP))(context.Background())
	requireProxyFailure(t, conn, err, proxyUnreachable)
	if status := readStatus(); status["revision"] != "replacement" || status["proxy_diagnostic"] != nil || dials != 2 {
		t.Fatalf("old work leaked a diagnostic into replacement: %v, dials %d", status, dials)
	}
}

func TestManagedNetworkClosesOldUDPBeforeBinding(t *testing.T) {
	route, _ := startProxyDNSFixture(t, http.NotFoundHandler())
	cfg := testGvproxyConfig()
	tap := startNetworkWithSeams(t, cfg, networkSeams{beforeAttach: func(ctx context.Context, policy *outboundPolicyController) {
		gateway, err := policy.installManagedNetwork(ctx, route.work, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(gateway.server.close)
	}})
	upstream, port := listenUDP(t)
	id := stack.TransportEndpointID{
		LocalAddress: addr(t, unlistedIP), LocalPort: port,
		RemoteAddress: addr(t, cfg.GuestIP), RemotePort: guestSrcPort,
	}
	endpointPresent := func(guestPort uint16) bool {
		endpoint := id
		endpoint.RemotePort = guestPort
		return tap.policy.stack.FindTransportEndpoint(ipv4.ProtocolNumber, udp.ProtocolNumber, endpoint, tap.policy.nic) != nil
	}

	receive := func(want string) net.Addr {
		t.Helper()
		_ = upstream.SetReadDeadline(time.Now().Add(forwardWindow))
		buffer := make([]byte, 512)
		n, peer, err := upstream.ReadFrom(buffer)
		if err != nil || string(buffer[:n]) != want {
			t.Fatalf("external UDP got %q, error %v", buffer[:n], err)
		}
		return peer
	}
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("before bind")))
	oldPeer := receive("before bind")
	oldRelay := tap.policy.active.Load().udpRelay
	if oldRelay == nil || !endpointPresent(guestSrcPort) {
		t.Fatal("unbound managed relay did not register a Guest endpoint")
	}
	if _, err := upstream.WriteTo([]byte("old control reply"), oldPeer); err != nil {
		t.Fatalf("send old control reply: %v", err)
	}
	if payload, ok := readManagedGuestUDP(tap, port, guestSrcPort); !ok || payload != "old control reply" {
		t.Fatalf("old Guest port did not receive its control reply: %q", payload)
	}

	ctx, cancel := context.WithTimeout(context.Background(), forwardWindow)
	defer cancel()
	if err := replaceManagedRouteForTest(tap.policy, ctx, outboundPolicy{Mode: "enabled"}, "bound", route); err != nil {
		t.Fatal(err)
	}
	if !oldRelay.generation.isSealed() || oldRelay.ctx.Err() == nil || endpointPresent(guestSrcPort) {
		t.Fatal("binding succeeded while the old UDP endpoint was live")
	}
	_, _ = upstream.WriteTo([]byte("late reply"), oldPeer)
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("bound")))
	assertDatagramDropped(t, upstream, "bound managed network sent external UDP")

	nextCtx, nextCancel := context.WithTimeout(context.Background(), forwardWindow)
	defer nextCancel()
	if err := replaceManagedRouteForTest(tap.policy, nextCtx, outboundPolicy{Mode: "enabled", AllowNet: []string{unlistedIP}}, "unbound-again", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := upstream.WriteTo([]byte("late reply after unbind"), oldPeer); err != nil {
		t.Fatalf("send delayed reply after unbind: %v", err)
	}
	if payload, ok := readManagedGuestUDP(tap, port, guestSrcPort); ok {
		t.Fatalf("old Guest port received a packet after unbind: %q", payload)
	}
	const freshGuestPort = guestSrcPort + 1
	tap.send(t, udpFrameFrom(t, unlistedIP, freshGuestPort, port, []byte("after unbind")))
	freshPeer := receive("after unbind")
	if snapshot := tap.policy.active.Load(); snapshot.udpRelay == oldRelay || endpointPresent(guestSrcPort) || !endpointPresent(freshGuestPort) {
		t.Fatal("unbind did not create a fresh managed UDP endpoint")
	}
	if _, err := upstream.WriteTo([]byte("fresh reply after unbind"), freshPeer); err != nil {
		t.Fatalf("send fresh reply after unbind: %v", err)
	}
	if payload, ok := readManagedGuestUDP(tap, port, freshGuestPort); !ok || payload != "fresh reply after unbind" {
		t.Fatalf("fresh Guest port did not receive its reply: %q", payload)
	}
}

func TestManagedNetworkPreservesDHCPWhileBlockingExternalUDP(t *testing.T) {
	route, _ := startProxyDNSFixture(t, http.NotFoundHandler())
	cfg := testGvproxyConfig()
	tap := startNetworkWithSeams(t, cfg, networkSeams{beforeAttach: func(ctx context.Context, policy *outboundPolicyController) {
		gateway, err := policy.installManagedNetwork(ctx, route.work, route, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(gateway.server.close)
	}})

	const xid = uint32(0x01234567)
	request := make([]byte, 240)
	request[0], request[1], request[2] = 1, 1, 6 // BOOTREQUEST, Ethernet, six-byte MAC.
	binary.BigEndian.PutUint32(request[4:8], xid)
	copy(request[12:16], net.ParseIP(cfg.GuestIP).To4())
	copy(request[28:34], mac(t, cfg.GuestMac))
	copy(request[236:240], []byte{99, 130, 83, 99})
	request = append(request, 53, 1, 3, 255) // DHCPREQUEST and end option.
	tap.send(t, udpFrameFrom(t, cfg.GatewayIP, 68, 67, request))
	ack, received := readManagedGuestUDP(tap, 67, 68)
	if !received || len(ack) < 240 || ack[0] != 2 || binary.BigEndian.Uint32([]byte(ack[4:8])) != xid ||
		ack[28:34] != string(mac(t, cfg.GuestMac)) || net.IP(ack[16:20]).String() != cfg.GuestIP ||
		ack[236:240] != string(request[236:240]) {
		t.Fatal("the bound guest missed the lease reply for its DHCP transaction")
	}
	var gotAck, gotServer bool
	for options := []byte(ack[240:]); len(options) > 0 && options[0] != 255; {
		if options[0] == 0 {
			options = options[1:]
			continue
		}
		if len(options) < 2 || len(options) < 2+int(options[1]) {
			t.Fatal("malformed DHCP reply option")
		}
		value := options[2 : 2+int(options[1])]
		switch options[0] {
		case 53:
			gotAck = len(value) == 1 && value[0] == 5
		case 54:
			gotServer = net.IP(value).String() == cfg.GatewayIP
		}
		options = options[2+len(value):]
	}
	if !gotAck || !gotServer {
		t.Fatal("the matching DHCP reply was not an ACK from the gateway")
	}
	upstream, port := listenUDP(t)
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("external while bound")))
	assertDatagramDropped(t, upstream, "bound DHCP control allowed external UDP")
}

func readManagedGuestUDP(tap *guestTap, srcPort, dstPort uint16) (string, bool) {
	deadline := time.NewTimer(forwardWindow)
	defer deadline.Stop()
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
			packet := header.UDP(ip.Payload())
			if packet.SourcePort() == srcPort && packet.DestinationPort() == dstPort {
				return string(packet.Payload()), true
			}
		case <-deadline.C:
			return "", false
		}
	}
}

func TestManagedRecoveryGateSurvivesUpdateAndSealRejectsDelayedRelease(t *testing.T) {
	gate := recoveryGateID{Epoch: "epoch-recovery", Generation: "generation-recovery"}
	tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{beforeAttach: func(ctx context.Context, p *outboundPolicyController) {
		gateway, err := p.installManagedNetwork(ctx, newDNSLookupWork(ctx), nil, &gate)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(gateway.server.close)
	}})
	upstream, port := listenUDP(t)
	send := func(payload string) { tap.send(t, udpFrame(t, unlistedIP, port, []byte(payload))) }
	send("before recovery release")
	assertDatagramDropped(t, upstream, "fresh recovery network sent external UDP")

	update := func(epoch, previous, candidate string, want int) {
		t.Helper()
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPut, outboundSnapshotPath, strings.NewReader(`{"mode":"enabled","proxy_route":null}`))
		request.Header.Set("If-Match", outboundETag(previous))
		request.Header.Set(outboundRevisionHeader, candidate)
		request.Header.Set("X-BoxLite-Managed-Epoch", epoch)
		tap.policy.ServeHTTP(recorder, request)
		if recorder.Code != want {
			t.Fatalf("policy update returned %d, want %d", recorder.Code, want)
		}
	}
	update("old-epoch", tap.policy.active.Load().revision, "rejected", http.StatusPreconditionFailed)
	update(gate.Epoch, tap.policy.active.Load().revision, "recovered", http.StatusOK)
	send("after policy publication")
	assertDatagramDropped(t, upstream, "policy update opened the recovery gate")

	change := func(request recoveryGateRequest, want int) {
		t.Helper()
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		tap.policy.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, outboundRecoveryGatePath, strings.NewReader(string(body))))
		if recorder.Code != want {
			t.Fatalf("gate %s returned %d, want %d", request.Action, recorder.Code, want)
		}
	}
	stale := recoveryGateRequest{recoveryGateID: recoveryGateID{Epoch: "old", Generation: gate.Generation}, Action: "release", Revision: "recovered"}
	change(stale, http.StatusPreconditionFailed)
	release := recoveryGateRequest{recoveryGateID: gate, Action: "release", Revision: "recovered"}
	change(release, http.StatusNoContent)
	send("released")
	_ = upstream.SetReadDeadline(time.Now().Add(forwardWindow))
	buffer := make([]byte, 128)
	n, _, err := upstream.ReadFrom(buffer)
	if err != nil || string(buffer[:n]) != "released" {
		t.Fatalf("released recovery network got %q, error %v", buffer[:n], err)
	}

	seal := release
	seal.Action = "seal"
	change(seal, http.StatusNoContent)
	change(release, http.StatusConflict)
	send("after seal")
	assertDatagramDropped(t, upstream, "delayed release reopened the sealed epoch")
	update(gate.Epoch, "recovered", "late-update", http.StatusConflict)
}

type pausedManagedEnable struct {
	nicOperations
	enter  chan struct{}
	resume chan struct{}
}

func (n pausedManagedEnable) EnableNIC(id tcpip.NICID) tcpip.Error {
	err := n.nicOperations.EnableNIC(id)
	close(n.enter)
	<-n.resume
	return err
}

func TestManagedNetworkStoppedBeforeCandidatePublication(t *testing.T) {
	cfg := testGvproxyConfig()
	tap := startNetworkWithSeams(t, cfg, networkSeams{beforeAttach: func(ctx context.Context, p *outboundPolicyController) {
		gateway, err := p.installManagedNetwork(ctx, newDNSLookupWork(ctx), nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(gateway.server.close)
	}})
	ctx, cancel := context.WithTimeout(context.Background(), forwardWindow)
	defer cancel()
	if err := replaceManagedRouteForTest(tap.policy, ctx, outboundPolicy{Mode: "disabled"}, "disabled", nil); err != nil {
		t.Fatal(err)
	}
	pause := pausedManagedEnable{nicOperations: tap.policy.nicOps, enter: make(chan struct{}), resume: make(chan struct{})}
	tap.policy.nicOps = pause
	update := make(chan error, 1)
	go func() {
		update <- replaceManagedRouteForTest(tap.policy, ctx, outboundPolicy{Mode: "enabled"}, "would-enable", nil)
	}()
	select {
	case <-pause.enter:
	case <-ctx.Done():
		close(pause.resume)
		t.Fatal("update did not reach guest NIC enable")
	}
	tap.policy.stopManagedNetwork()
	close(pause.resume)
	select {
	case err := <-update:
		if err == nil {
			t.Fatal("stopped network confirmed an in-flight candidate")
		}
	case <-ctx.Done():
		t.Fatal("stopped update did not return")
	}
	snapshot := tap.policy.active.Load()
	if !snapshot.ingressClosed() || snapshot.revision != "disabled" || snapshot.udpRelay != nil || snapshot.state != "uncertain" {
		t.Fatalf("unexpected stopped snapshot: %+v", snapshot)
	}
}

func replaceManagedRouteForTest(p *outboundPolicyController, ctx context.Context, policy outboundPolicy, revision string, route *proxyDNSResolver) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.replaceManagedRoute(ctx, policy, revision, route)
}
