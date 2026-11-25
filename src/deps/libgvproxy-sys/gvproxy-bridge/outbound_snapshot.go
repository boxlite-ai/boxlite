package main

import (
	"fmt"

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
	cloud       bool
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
	rules := policy.tcp
	policy.tcp = nil
	snapshot := &outboundSnapshot{
		policy: policy, revision: revision, filter: filter, dialer: dialer, legacyAllow: policy.AllowNet,
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
	s.extended, s.cloud = policy, rules.cloud
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
	next     int
}

func (t *outboundModeTarget) Action(*stack.PacketBuffer, stack.Hook, *stack.Route, stack.AddressableEndpoint) (stack.RuleVerdict, int) {
	if t.snapshot().policy.Mode == "disabled" {
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
