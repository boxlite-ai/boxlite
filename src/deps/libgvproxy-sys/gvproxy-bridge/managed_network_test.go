package main

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

func TestManagedNetworkClosesOldUDPBeforeBinding(t *testing.T) {
	route, _ := startProxyDNSFixture(t, http.NotFoundHandler())
	cfg := testGvproxyConfig()
	tap := startNetworkWithSeams(t, cfg, networkSeams{beforeAttach: func(ctx context.Context, policy *outboundPolicyController) {
		gateway, err := policy.installManagedNetwork(ctx, route.work, nil)
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
	endpointPresent := func() bool {
		return tap.policy.stack.FindTransportEndpoint(ipv4.ProtocolNumber, udp.ProtocolNumber, id, tap.policy.nic) != nil
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
	if oldRelay == nil || !endpointPresent() {
		t.Fatal("unbound managed relay did not register a Guest endpoint")
	}

	ctx, cancel := context.WithTimeout(context.Background(), forwardWindow)
	defer cancel()
	if err := replaceManagedRouteForTest(tap.policy, ctx, outboundPolicy{Mode: "enabled"}, "bound", route); err != nil {
		t.Fatal(err)
	}
	if !oldRelay.generation.isSealed() || oldRelay.ctx.Err() == nil || endpointPresent() {
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
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("after unbind")))
	receive("after unbind")
	if snapshot := tap.policy.active.Load(); snapshot.udpRelay == oldRelay || !endpointPresent() {
		t.Fatal("unbind did not create a fresh managed UDP endpoint")
	}
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
		gateway, err := p.installManagedNetwork(ctx, newDNSLookupWork(ctx), nil)
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
