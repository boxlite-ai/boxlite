package main

import (
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type outboundRuleFixtureTarget struct {
	IP          string `json:"policy_ip"`
	SocketIP    string `json:"connection_ip"`
	CandidateIP string `json:"candidate_ip"`
	Port        uint16 `json:"port"`
	Protocol    string `json:"protocol"`
	Hostname    string `json:"hostname"`
}

func (f outboundRuleFixtureTarget) target() egressTarget {
	target := egressTarget{
		PolicyIP: netip.MustParseAddr(f.IP),
		Port:     f.Port, Protocol: f.Protocol, Hostname: f.Hostname,
	}
	if f.SocketIP != "" {
		target.ConnectionIP = netip.MustParseAddr(f.SocketIP)
	}
	return target
}

func TestExtendedOutboundRules(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "outbound", "policy-rules-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases struct {
		Rules []struct {
			ID, Rule  string
			Canonical *string
		} `json:"rule_cases"`
		Lists []struct {
			ID    string
			Allow int `json:"allow_count"`
			Deny  int `json:"deny_count"`
			Valid bool
		} `json:"list_cases"`
		Matches []struct {
			ID, Rule string
			Target   outboundRuleFixtureTarget
			Matches  bool
		} `json:"match_cases"`
		Decisions []struct {
			ID     string
			Policy struct {
				Mode  string
				Allow []string `json:"allow_net"`
				Deny  []string `json:"deny_net"`
			}
			Target         outboundRuleFixtureTarget
			NameAssociated bool `json:"name_associated"`
			PlatformDenied bool `json:"platform_denied"`
			SecretsMatch   bool `json:"secrets_match"`
			Outcome        outboundReason
		} `json:"decision_cases"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Rules) == 0 || len(cases.Lists) == 0 || len(cases.Matches) == 0 || len(cases.Decisions) == 0 {
		t.Fatal("missing outbound rule fixture groups")
	}

	for _, c := range cases.Rules {
		t.Run("rule/"+c.ID, func(t *testing.T) {
			rule, err := parseOutboundRule(c.Rule)
			if c.Canonical == nil {
				if err == nil {
					t.Fatalf("accepted invalid rule %q as %q", c.Rule, rule.canonical)
				}
				return
			}
			if err != nil || rule.canonical != *c.Canonical {
				t.Fatalf("parse %q = (%q, %v), want %q", c.Rule, rule.canonical, err, *c.Canonical)
			}
		})
	}
	for _, c := range cases.Lists {
		t.Run("list/"+c.ID, func(t *testing.T) {
			allow := slices.Repeat([]string{"api.example.com"}, c.Allow)
			deny := slices.Repeat([]string{"192.0.2.0/24"}, c.Deny)
			policy, err := compileExtendedOutboundPolicy("enabled", allow, deny)
			if (err == nil) != c.Valid || (policy != nil) != c.Valid {
				t.Fatalf("compile valid = %v, policy present = %v, want %v", err == nil, policy != nil, c.Valid)
			}
		})
	}
	for _, c := range cases.Matches {
		t.Run("match/"+c.ID, func(t *testing.T) {
			rule, err := parseOutboundRule(c.Rule)
			if err != nil {
				t.Fatal(err)
			}
			target := c.Target.target()
			name := outboundObservedName(target.Hostname)
			if got := rule.matches(target.PolicyIP.Unmap(), name, target.Port); got != c.Matches {
				t.Fatalf("match = %v, want %v", got, c.Matches)
			}
		})
	}
	for _, c := range cases.Decisions {
		t.Run("decision/"+c.ID, func(t *testing.T) {
			policy := mustCompileExtended(t, c.Policy.Mode, c.Policy.Allow, c.Policy.Deny)
			target := c.Target.target()
			names := outboundNameFacts{secretsMatch: c.SecretsMatch}
			if c.NameAssociated {
				if !target.ConnectionIP.IsValid() {
					t.Fatal("associated name fixture requires the socket address")
				}
				names.associatedAddress = target.ConnectionIP
			}
			facts := outboundAddressFacts{address: target.PolicyIP.Unmap(), platformDenied: c.PlatformDenied}
			got := policy.evaluate(target, facts, names).reason
			if c.Target.CandidateIP != "" && got == outboundAllowed {
				candidate := outboundAddressFacts{address: netip.MustParseAddr(c.Target.CandidateIP).Unmap()}
				got = policy.checkCandidate(candidate, target.Port)
			}
			if got != c.Outcome {
				t.Fatalf("decision = %q, want %q", got, c.Outcome)
			}
		})
	}
}

func TestExtendedOutboundNameHandoff(t *testing.T) {
	ip := netip.MustParseAddr("198.51.100.8")
	socket := netip.MustParseAddr("203.0.113.8")
	facts := outboundAddressFacts{address: ip}
	target := egressTarget{PolicyIP: ip, ConnectionIP: socket, Port: 443, Protocol: "tcp"}
	addressRule := ip.String()
	nameRule := "api.example.com:443"
	allow := mustCompileExtended(t, "enabled", []string{addressRule, nameRule}, nil)
	deny := mustCompileExtended(t, "enabled", []string{addressRule, nameRule}, []string{"*.blocked.example:443"})
	nameOnly := mustCompileExtended(t, "enabled", []string{nameRule}, nil)
	pending := outboundNameFacts{inspectionPending: true}
	mightUseSecrets := outboundNameFacts{inspectionPending: true, secretsPossible: true}

	for _, c := range []struct {
		name   string
		policy *extendedOutboundPolicy
		names  outboundNameFacts
		want   outboundDecision
	}{
		{"address grant needs no name allow", allow, pending, outboundDecision{reason: outboundAllowed, route: outboundAddressRoute}},
		{"possible secrets change the route", allow, mightUseSecrets, outboundDecision{reason: outboundInspectName}},
		{"name deny requires inspection", deny, pending, outboundDecision{reason: outboundInspectName}},
		{"name allow can grant a missed flow", nameOnly, pending, outboundDecision{reason: outboundInspectName}},
		{"unavailable after inspection", deny, outboundNameFacts{}, outboundDecision{reason: outboundHostnameRequired}},
		{"no observed secrets uses address", allow, outboundNameFacts{secretsPossible: true}, outboundDecision{reason: outboundAllowed, route: outboundAddressRoute}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := c.policy.evaluate(target, facts, c.names); got != c.want {
				t.Fatalf("decision = %+v, want %+v", got, c.want)
			}
		})
	}

	target.Hostname = "API.Example.COM."
	if got := allow.evaluate(target, facts, outboundNameFacts{secretsMatch: true}); got.route != outboundSecretsRoute || got.reason != outboundAllowed {
		t.Fatalf("secrets must select a name route, got %+v", got)
	}
	if got := nameOnly.evaluate(target, facts, outboundNameFacts{}); got.reason != outboundAllowed || got.route != outboundNameRoute {
		t.Fatalf("a checked name route must not require address association, got %+v", got)
	}
	for _, associated := range []netip.Addr{{}, ip} {
		got := deny.evaluate(target, facts, outboundNameFacts{associatedAddress: associated})
		if got.reason != outboundHostnameRequired || !got.checkAssociation {
			t.Fatalf("missing or wrong socket association allowed: %+v", got)
		}
	}
	if got := deny.evaluate(target, facts, outboundNameFacts{associatedAddress: socket}); got.reason != outboundAllowed || got.route != outboundAddressRoute {
		t.Fatalf("verified socket association must allow address route, got %+v", got)
	}
	target.Protocol = "udp"
	if got := deny.evaluate(target, facts, pending); got.reason != outboundHostnameRequired {
		t.Fatalf("UDP must treat the name as unavailable, got %+v", got)
	}
}

func TestExtendedOutboundCandidateFacts(t *testing.T) {
	policy := mustCompileExtended(t, "enabled", []string{"api.example.com", "192.168.1.0/24:443"}, []string{"192.168.1.9:443"})
	mapped := netip.MustParseAddr("::ffff:192.168.1.8")
	local := outboundAddressFacts{address: mapped.Unmap(), restrictedLocal: true}
	denied := outboundAddressFacts{address: local.address, platformDenied: true, restrictedLocal: true}
	userDenied := outboundAddressFacts{address: netip.MustParseAddr("192.168.1.9"), restrictedLocal: true}
	for _, c := range []struct {
		facts outboundAddressFacts
		port  uint16
		want  outboundReason
	}{
		{local, 443, outboundAllowed},
		{local, 8443, outboundCandidateNeedsIP},
		{denied, 443, outboundPlatformDeny},
		{userDenied, 443, outboundUserDeny},
		{outboundAddressFacts{address: mapped}, 443, outboundInvalidTarget},
	} {
		if got := policy.checkCandidate(c.facts, c.port); got != c.want {
			t.Fatalf("candidate %v port %d = %q, want %q", c.facts, c.port, got, c.want)
		}
	}
	target := egressTarget{PolicyIP: mapped, Protocol: "tcp", Port: 443}
	if got := policy.evaluate(target, denied, outboundNameFacts{}); got.reason != outboundPlatformDeny {
		t.Fatalf("mapped target must use the matching normalized platform denial, got %+v", got)
	}
	if got := policy.evaluate(target, userDenied, outboundNameFacts{}); got.reason != outboundInvalidTarget {
		t.Fatalf("accepted platform facts for a different address: %+v", got)
	}
}

func TestExtendedOutboundPolicyCompileIsAtomic(t *testing.T) {
	for _, c := range []struct {
		mode  string
		allow []string
		deny  []string
	}{
		{"enabled", []string{"api.example.com", ""}, nil},
		{"enabled", []string{"api.example.com"}, []string{"192.0.2.8", "bad host"}},
		{"disabled", []string{"api.example.com"}, nil},
		{"unknown", nil, nil},
	} {
		if policy, err := compileExtendedOutboundPolicy(c.mode, c.allow, c.deny); policy != nil || err == nil {
			t.Fatalf("invalid input produced policy %v and error %v", policy, err)
		}
	}
	allow := []string{"192.0.2.8", "example.org"}
	deny := []string{"192.0.2.8:443", "*.example.com"}
	original := mustCompileExtended(t, "enabled", allow, deny)
	slices.Reverse(allow)
	slices.Reverse(deny)
	reversed := mustCompileExtended(t, "enabled", allow, deny)
	deny[1] = "198.51.100.8"
	target := egressTarget{PolicyIP: netip.MustParseAddr("192.0.2.8"), Hostname: "example.org", Port: 443, Protocol: "tcp"}
	facts := outboundAddressFacts{address: target.PolicyIP}
	for _, policy := range []*extendedOutboundPolicy{original, reversed} {
		if got := policy.evaluate(target, facts, outboundNameFacts{}); got.reason != outboundUserDeny {
			t.Fatalf("rule order or mutation changed the deny, got %+v", got)
		}
	}
}

func TestExtendedOutboundRuleNameLengths(t *testing.T) {
	label := strings.Repeat("a", 63)
	name := strings.Join([]string{label, label, label, strings.Repeat("b", 61)}, ".")
	for _, text := range []string{label, name, "*." + name} {
		if _, err := parseOutboundRule(text); err != nil {
			t.Fatalf("rejects valid %d-byte rule %q: %v", len(text), text, err)
		}
	}
	for _, text := range []string{label + "a", name + "b", "*." + name + "b"} {
		if _, err := parseOutboundRule(text); err == nil {
			t.Fatalf("accepts overlength rule %q", text)
		}
	}
}

func mustCompileExtended(t *testing.T, mode string, allow, deny []string) *extendedOutboundPolicy {
	t.Helper()
	policy, err := compileExtendedOutboundPolicy(mode, allow, deny)
	if err != nil {
		t.Fatal(err)
	}
	return policy
}
