package main

import (
	"fmt"
	"net"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

// Published snapshots are immutable. A flow keeps its filter and dialer even
// when a replacement publishes another snapshot or changes application state.
type outboundSnapshot struct {
	policy      outboundPolicy
	revision    string
	filter      *AllowNetFilter
	legacyAllow []string
	extended    *extendedOutboundPolicy
	dialer      *egressDialer
	state       string
}

type snapshotSource func() *outboundSnapshot

func (p *outboundPolicyController) compile(policy outboundPolicy, revision string) (*outboundSnapshot, error) {
	policy.AllowNet = append([]string{}, policy.AllowNet...)
	filter := NewAllowNetFilter(policy.AllowNet, p.config.GatewayIP, p.guestIP)
	dialer, err := newEgressDialer(filter, p.config.Subnet)
	if err != nil {
		return nil, err
	}
	dialer.guard = p.guard
	if p.resolve != nil {
		dialer.resolve = p.resolve
	}
	rules := policy.tcp
	policy.tcp = nil
	snapshot := &outboundSnapshot{
		policy: policy, revision: revision, filter: filter, dialer: dialer, legacyAllow: policy.AllowNet,
		extended: policy.compiled,
	}
	if rules != nil {
		if err := snapshot.setTCPPolicy(policy.Mode, *rules); err != nil {
			return nil, err
		}
	}
	return snapshot, nil
}

func (s *outboundSnapshot) setTCPPolicy(mode string, rules trustedTCPRules) error {
	policy, err := compileExtendedOutboundPolicy(mode, rules.allow, rules.deny)
	if err != nil {
		return err
	}
	s.extended = policy
	s.policy = outboundPolicy{Mode: mode, AllowNet: s.legacyAllow}
	if mode == "disabled" {
		s.policy.AllowNet = []string{}
	}
	return nil
}

func (p *outboundPolicyController) publish(snapshot *outboundSnapshot, state string) {
	next := *snapshot
	next.state = state
	p.active.Store(&next)
}

// The input/forward gate precedes endpoint demultiplexing, including registered
// DNS sockets and established connections. It remains effective if DisableNIC
// fails. Enabled packets continue through the original filter-table chains.
type outboundModeTarget struct {
	snapshot snapshotSource
	guard    platformGuard
	guestNIC tcpip.NICID
	gateway  tcpip.Address
	next     int
}

func guestTrafficAllowed(current *outboundSnapshot) bool {
	return current != nil && current.policy.Mode != "disabled"
}

func (t *outboundModeTarget) Action(pkt *stack.PacketBuffer, _ stack.Hook, _ *stack.Route, _ stack.AddressableEndpoint) (stack.RuleVerdict, int) {
	if !guestTrafficAllowed(t.snapshot()) || (t.guard.cloud && !t.permitsGuestDHCP(pkt)) {
		return stack.RuleDrop, 0
	}
	return stack.RuleJump, t.next
}

func (t *outboundModeTarget) permitsGuestDHCP(pkt *stack.PacketBuffer) bool {
	ip := header.IPv4(pkt.NetworkHeader().Slice())
	if ip.TransportProtocol() != header.UDPProtocolNumber || ip.FragmentOffset() != 0 {
		return true
	}
	udp := header.UDP(pkt.TransportHeader().Slice())
	if ip.More() {
		// The input hook runs before reassembly. Only the first fragment has
		// ports, and gVisor keeps its UDP header in packet data until reassembly.
		first, ok := pkt.Data().PullUp(header.UDPMinimumSize)
		if !ok {
			return false
		}
		udp = header.UDP(first)
	}
	if len(udp) < header.UDPMinimumSize {
		return false
	}
	const dhcpServerPort, dhcpClientPort = 67, 68
	if udp.DestinationPort() != dhcpServerPort {
		return true
	}
	destination := ip.DestinationAddress()
	return pkt.NICID == t.guestNIC && udp.SourcePort() == dhcpClientPort &&
		(destination == t.gateway || destination == header.IPv4Broadcast)
}

func (p *outboundPolicyController) installOutboundModeGate() error {
	gateway := tcpip.AddrFromSlice(net.ParseIP(p.config.GatewayIP).To4())
	tables := p.stack.IPTables()
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
			Filter: stack.EmptyFilter4(),
			Target: &outboundModeTarget{snapshot: p.active.Load, guard: p.guard, guestNIC: p.nic, gateway: gateway, next: entry},
		}, stack.Rule{
			// A returned original chain must use this hook's underflow,
			// rather than falling through into the next appended gate.
			Filter: stack.EmptyFilter4(), Target: &stack.ReturnTarget{NetworkProtocol: header.IPv4ProtocolNumber},
		})
	}
	tables.ReplaceTable(stack.FilterID, table, false)
	return nil
}
