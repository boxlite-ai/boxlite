package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

const udpCutoverTimeout = 5 * time.Second

// installManagedNetwork runs before guest attachment. Only invoke it when the
// guest-link writer supports packet owners all the way to the Unix socket.
func (p *outboundPolicyController) installManagedNetwork(ctx context.Context, work *dnsLookupWork, route *proxyDNSResolver, gate *recoveryGateID) (*gatewayDNS, error) {
	gateway, err := p.installGatewayDNS(ctx, work)
	if err != nil {
		return nil, err
	}
	nat := natTable(p.config)
	var natLock sync.Mutex
	dial := p.active.Load().dialer.dial
	p.newUDPRelay = func() *managedUDP {
		return newManagedUDP(ctx, p.stack, nat, &natLock, dial)
	}
	p.managedContext = ctx
	snapshot := *p.active.Load()
	snapshot.managed = true
	if gate != nil {
		snapshot.recoveryGate = &recoveryGate{recoveryGateID: *gate, Closed: true}
	}
	if route != nil {
		snapshot.proxyDNS = route
		snapshot.configureResolution(work)
	}
	if !snapshot.ingressClosed() && snapshot.proxyDNS == nil {
		snapshot.udpRelay = p.newUDPRelay()
	}
	if !p.publish(&snapshot, snapshot.state) {
		if snapshot.udpRelay != nil {
			snapshot.udpRelay.seal()
		}
		gateway.server.close()
		return nil, fmt.Errorf("managed network startup canceled")
	}
	context.AfterFunc(ctx, p.stopManagedNetwork)
	return gateway, nil
}

func (p *outboundPolicyController) stopManagedNetwork() {
	p.publication.Lock()
	p.stopped = true
	stopped := *p.active.Load()
	stopped.state = "uncertain"
	stopped.blockAll = true
	p.active.Store(&stopped)
	p.publication.Unlock()
	if stopped.udpRelay != nil {
		stopped.udpRelay.seal()
	}
}

// waitManagedNetwork joins work after the instance stops admission and closes
// the control and guest-link sockets.
func (p *outboundPolicyController) waitManagedNetwork(gateway *gatewayDNS) {
	p.puts.Wait()
	if relay := p.active.Load().udpRelay; relay != nil {
		<-relay.generation.drained
	}
	gateway.server.close()
	p.dnsWork.waitForShutdown()
}

// replaceManagedRoute applies a complete trusted configuration under p.mu.
func (p *outboundPolicyController) replaceManagedRoute(ctx context.Context, policy outboundPolicy, revision string, route *proxyDNSResolver) error {
	previous := p.active.Load()
	if !previous.managed {
		return fmt.Errorf("managed proxy network is unavailable")
	}
	if !validOutboundRevision(revision) || revision == previous.revision {
		return fmt.Errorf("invalid candidate outbound revision")
	}
	if err := policy.validate(); err != nil {
		return err
	}
	if route != nil && route.work != p.dnsWork {
		return fmt.Errorf("proxy route must use the instance's DNS lookup capacity")
	}
	candidate, err := p.compileRoute(policy, revision, route)
	if err != nil {
		return err
	}
	return p.applyManaged(ctx, previous, candidate)
}

func (p *outboundPolicyController) applyManaged(ctx context.Context, previous, candidate *outboundSnapshot) error {
	pending := *previous
	pending.blockAll = previous.ingressClosed() || candidate.ingressClosed()
	if !p.publish(&pending, "pending") {
		return fmt.Errorf("managed network stopped")
	}
	fail := func(err error) error {
		p.publish(&pending, "uncertain")
		return err
	}
	if previous.udpRelay != nil {
		drain, cancel := context.WithTimeout(ctx, udpCutoverTimeout)
		previous.udpRelay.seal()
		err := previous.udpRelay.generation.wait(drain)
		cancel()
		if err != nil {
			return fail(fmt.Errorf("drain old UDP generation: %w", err))
		}
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	enabled := candidate.policy.Mode != "disabled"
	if !enabled {
		if err := p.nicOps.DisableNIC(p.nic); err != nil {
			return fail(fmt.Errorf("suspend guest NIC: %s", err))
		}
	} else if pending.blockAll || !p.stack.CheckNIC(p.nic) {
		if err := p.nicOps.EnableNIC(p.nic); err != nil {
			return fail(fmt.Errorf("enable guest NIC: %s", err))
		}
	}
	if p.stack.CheckNIC(p.nic) != enabled {
		return fail(fmt.Errorf("guest NIC did not reach requested state"))
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	if !candidate.ingressClosed() && candidate.proxyDNS == nil {
		candidate.udpRelay = p.newUDPRelay()
	}
	if !p.publish(candidate, "confirmed") {
		if candidate.udpRelay != nil {
			candidate.udpRelay.seal()
		}
		return fmt.Errorf("managed network stopped before confirmation")
	}
	return nil
}
