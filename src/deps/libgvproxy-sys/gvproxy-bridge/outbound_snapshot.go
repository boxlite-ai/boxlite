package main

import (
	"context"
	"fmt"
	"net"
	"sync/atomic"

	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

// Published snapshots are immutable. A flow keeps its filter and dialer even
// when a replacement publishes another snapshot or changes application state.
type outboundSnapshot struct {
	policy       outboundPolicy
	revision     string
	filter       *AllowNetFilter
	dialer       *egressDialer
	proxyDNS     *proxyDNSResolver
	udpRelay     *managedUDP
	managed      bool
	blockAll     bool
	recoveryGate *recoveryGate
	state        string
}

type snapshotSource func() *outboundSnapshot

func (p *outboundPolicyController) compile(policy outboundPolicy, revision string) (*outboundSnapshot, error) {
	var route *proxyDNSResolver
	if previous := p.active.Load(); previous != nil {
		route = previous.proxyDNS
	}
	return p.compileRoute(policy, revision, route)
}

func (p *outboundPolicyController) compileRoute(policy outboundPolicy, revision string, route *proxyDNSResolver) (*outboundSnapshot, error) {
	policy.AllowNet = append([]string{}, policy.AllowNet...)
	filter := NewAllowNetFilter(policy.AllowNet, p.config.GatewayIP, p.guestIP)
	dialer, err := newEgressDialer(filter, p.config.Subnet)
	if err != nil {
		return nil, err
	}
	next := &outboundSnapshot{
		policy: policy, revision: revision, filter: filter, dialer: dialer,
		proxyDNS: route, managed: p.newUDPRelay != nil,
	}
	if previous := p.active.Load(); previous != nil {
		next.recoveryGate = previous.recoveryGate
	}
	next.configureResolution(p.dnsWork)
	return next, nil
}

func (s *outboundSnapshot) ingressClosed() bool {
	return s.blockAll || s.policy.Mode == "disabled" || (s.recoveryGate != nil && s.recoveryGate.Closed)
}

func (s *outboundSnapshot) configureResolution(work *dnsLookupWork) {
	if s.proxyDNS == nil && work == nil {
		return
	}
	dialer := *s.dialer
	if s.proxyDNS != nil {
		dialer.resolve = s.proxyDNS.lookupIP
		dialer.connect = s.proxyDNS.connect
		dialer.diagnostic = new(atomic.Pointer[proxyFailure])
	} else {
		resolve := dialer.resolve
		dialer.resolve = func(ctx context.Context, name string) ([]net.IP, error) {
			ctx, release, err := work.begin(ctx)
			if err != nil {
				return nil, err
			}
			defer release()
			return resolve(ctx, name)
		}
	}
	s.dialer = &dialer
}

func (p *outboundPolicyController) publish(snapshot *outboundSnapshot, state string) bool {
	p.publication.Lock()
	defer p.publication.Unlock()
	if p.stopped || (p.managedContext != nil && p.managedContext.Err() != nil) {
		return false
	}
	next := *snapshot
	next.state = state
	p.active.Store(&next)
	return true
}

// The input/forward gate precedes endpoint demultiplexing, including registered
// DNS sockets and established connections. It remains effective if DisableNIC
// fails. Enabled packets continue through the original filter-table chains.
type outboundModeTarget struct {
	snapshot snapshotSource
	next     int
}

func (t *outboundModeTarget) Action(*stack.PacketBuffer, stack.Hook, *stack.Route, stack.AddressableEndpoint) (stack.RuleVerdict, int) {
	if t.snapshot().ingressClosed() {
		return stack.RuleDrop, 0
	}
	return stack.RuleJump, t.next
}

func installOutboundModeGate(s *stack.Stack, snapshot snapshotSource) error {
	tables := s.IPTables()
	table := tables.GetTable(stack.FilterID, false)
	table.Rules = append([]stack.Rule(nil), table.Rules...)
	ruleCount := len(table.Rules)
	for _, hook := range []stack.Hook{stack.Input, stack.Forward} {
		entry := table.BuiltinChains[hook]
		if entry < 0 || entry >= ruleCount {
			return fmt.Errorf("outbound mode gate: missing IPv4 filter hook %d", hook)
		}
		table.BuiltinChains[hook] = len(table.Rules)
		table.Rules = append(table.Rules, stack.Rule{
			Filter: stack.EmptyFilter4(), Target: &outboundModeTarget{snapshot: snapshot, next: entry},
		}, stack.Rule{
			// A returned original chain must use this hook's underflow,
			// rather than falling through into the next appended gate.
			Filter: stack.EmptyFilter4(), Target: &stack.ReturnTarget{NetworkProtocol: header.IPv4ProtocolNumber},
		})
	}
	tables.ReplaceTable(stack.FilterID, table, false)
	return nil
}
