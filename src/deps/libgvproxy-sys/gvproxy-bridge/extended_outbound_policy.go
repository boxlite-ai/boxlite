package main

import (
	"fmt"
	"net/netip"
)

const maxOutboundRules = 64

type extendedOutboundPolicy struct {
	enabled bool
	allow   []outboundRule
	deny    []outboundRule
}

func compileExtendedOutboundPolicy(mode string, allow, deny []string) (*extendedOutboundPolicy, error) {
	if mode != "enabled" && mode != "disabled" {
		return nil, fmt.Errorf("outbound mode must be enabled or disabled")
	}
	if len(allow) > maxOutboundRules || len(deny) > maxOutboundRules {
		return nil, fmt.Errorf("allow_net and deny_net each accept at most %d rules", maxOutboundRules)
	}
	if mode == "disabled" && len(allow) != 0 {
		return nil, fmt.Errorf("disabled policy cannot include allow_net")
	}
	allowRules, err := compileOutboundRules("allow_net", allow)
	if err != nil {
		return nil, err
	}
	denyRules, err := compileOutboundRules("deny_net", deny)
	if err != nil {
		return nil, err
	}
	return &extendedOutboundPolicy{enabled: mode == "enabled", allow: allowRules, deny: denyRules}, nil
}

func compileOutboundRules(field string, inputs []string) ([]outboundRule, error) {
	rules := make([]outboundRule, len(inputs))
	for i, input := range inputs {
		rule, err := parseOutboundRule(input)
		if err != nil {
			return nil, fmt.Errorf("%s[%d]: %w", field, i, err)
		}
		rules[i] = rule
	}
	return rules, nil
}

// outboundAddressFacts ties platform classification to the normalized address
// that user rules will check. The transport owns classification and dialing.
type outboundAddressFacts struct {
	address         netip.Addr
	platformDenied  bool
	restrictedLocal bool
}

func (f outboundAddressFacts) valid() bool {
	return f.address.IsValid() && !f.address.Is4In6() && f.address.Zone() == ""
}

type outboundNameFacts struct {
	inspectionPending bool
	secretsPossible   bool
	secretsMatch      bool
	associatedAddress netip.Addr
}

type outboundReason string

const (
	outboundAllowed          outboundReason = "allow"
	outboundAllowMiss        outboundReason = "allow-miss"
	outboundDisabled         outboundReason = "disabled"
	outboundPlatformDeny     outboundReason = "platform-deny"
	outboundUserDeny         outboundReason = "user-deny"
	outboundHostnameRequired outboundReason = "hostname-required"
	outboundInspectName      outboundReason = "inspect-name"
	outboundInvalidTarget    outboundReason = "invalid-target"
	outboundCandidateNeedsIP outboundReason = "candidate-address-required"
)

type outboundRoute string

const (
	outboundAddressRoute outboundRoute = "address"
	outboundNameRoute    outboundRoute = "name"
	outboundSecretsRoute outboundRoute = "secrets"
)

type outboundDecision struct {
	reason           outboundReason
	route            outboundRoute
	checkAssociation bool
}

func (p *extendedOutboundPolicy) evaluate(
	target egressTarget, address outboundAddressFacts, names outboundNameFacts,
) outboundDecision {
	if !p.enabled {
		return outboundDecision{reason: outboundDisabled}
	}
	port := target.Port
	if port == 0 || (target.Protocol != "tcp" && target.Protocol != "udp") ||
		!address.valid() || address.address != target.PolicyIP.Unmap() {
		return outboundDecision{reason: outboundInvalidTarget}
	}
	if address.platformDenied {
		return outboundDecision{reason: outboundPlatformDeny}
	}
	ip := address.address
	if outboundRulesMatch(p.deny, ip, "", port) {
		return outboundDecision{reason: outboundUserDeny}
	}
	addressAllowed := outboundRulesMatch(p.allow, ip, "", port)
	nameDeny := outboundHasNameRule(p.deny, port)
	name := ""
	if target.Protocol == "tcp" {
		if names.inspectionPending {
			nameCouldGrant := !addressAllowed && outboundHasNameRule(p.allow, port)
			if nameDeny || names.secretsPossible || nameCouldGrant {
				return outboundDecision{reason: outboundInspectName}
			}
		} else {
			name = outboundObservedName(target.Hostname)
		}
	}
	if outboundRulesMatch(p.deny, netip.Addr{}, name, port) {
		return outboundDecision{reason: outboundUserDeny}
	}
	if nameDeny && name == "" {
		return outboundDecision{reason: outboundHostnameRequired}
	}

	switch {
	case name != "" && names.secretsMatch:
		return outboundDecision{reason: outboundAllowed, route: outboundSecretsRoute}
	case addressAllowed:
		return outboundAddressDecision(target, nameDeny, names.associatedAddress)
	case outboundRulesMatch(p.allow, netip.Addr{}, name, port):
		return outboundDecision{reason: outboundAllowed, route: outboundNameRoute}
	case len(p.allow) == 0:
		return outboundAddressDecision(target, nameDeny, names.associatedAddress)
	default:
		return outboundDecision{reason: outboundAllowMiss}
	}
}

func outboundAddressDecision(target egressTarget, nameDeny bool, associated netip.Addr) outboundDecision {
	socket := target.ConnectionIP.Unmap()
	if nameDeny && (!socket.IsValid() || socket.Zone() != "" || associated.Unmap() != socket) {
		return outboundDecision{reason: outboundHostnameRequired, checkAssociation: true}
	}
	return outboundDecision{reason: outboundAllowed, route: outboundAddressRoute}
}

// checkCandidate checks one DNS answer after a name route has been granted.
func (p *extendedOutboundPolicy) checkCandidate(address outboundAddressFacts, port uint16) outboundReason {
	if !p.enabled {
		return outboundDisabled
	}
	if port == 0 || !address.valid() {
		return outboundInvalidTarget
	}
	if address.platformDenied {
		return outboundPlatformDeny
	}
	ip := address.address
	if outboundRulesMatch(p.deny, ip, "", port) {
		return outboundUserDeny
	}
	if address.restrictedLocal && len(p.allow) != 0 && !outboundRulesMatch(p.allow, ip, "", port) {
		return outboundCandidateNeedsIP
	}
	return outboundAllowed
}

func outboundRulesMatch(rules []outboundRule, ip netip.Addr, name string, port uint16) bool {
	for _, rule := range rules {
		if rule.matches(ip, name, port) {
			return true
		}
	}
	return false
}

func outboundHasNameRule(rules []outboundRule, port uint16) bool {
	for _, rule := range rules {
		if rule.name != "" && rule.portMatches(port) {
			return true
		}
	}
	return false
}
