package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
)

const completeOutboundStatusPath = "/network/outbound/complete-status"
const legacyOutboundRuleLimit = 10

const (
	legacyAdmission    = "legacy"
	extendedAdmission  = "extended_ipv4"
	dualStackAdmission = "extended_dual_stack"
)

type outboundCapabilities struct {
	Admission  bool `json:"admission"`
	Deny       bool `json:"deny"`
	Port       bool `json:"port"`
	Capacity   bool `json:"capacity"`
	NativeIPv6 bool `json:"native_ipv6,omitempty"`
}

func supportedOutboundCapabilities() outboundCapabilities {
	return outboundCapabilities{Admission: true, Deny: true, Port: true, Capacity: true, NativeIPv6: true}
}

func (capabilities outboundCapabilities) contains(required outboundCapabilities) bool {
	return (!required.Admission || capabilities.Admission) &&
		(!required.Deny || capabilities.Deny) && (!required.Port || capabilities.Port) &&
		(!required.Capacity || capabilities.Capacity) && (!required.NativeIPv6 || capabilities.NativeIPv6)
}

func (capabilities outboundCapabilities) union(other outboundCapabilities) outboundCapabilities {
	return outboundCapabilities{Admission: capabilities.Admission || other.Admission,
		Deny: capabilities.Deny || other.Deny, Port: capabilities.Port || other.Port,
		Capacity:   capabilities.Capacity || other.Capacity,
		NativeIPv6: capabilities.NativeIPv6 || other.NativeIPv6}
}

type completeOutboundPolicy struct {
	Mode     string   `json:"mode"`
	AllowNet []string `json:"allow_net"`
	DenyNet  []string `json:"deny_net"`
}

type completeOutboundSnapshot struct {
	Policy    completeOutboundPolicy `json:"policy"`
	Revision  string                 `json:"revision"`
	Admission string                 `json:"admission"`
	IPv6      *ipv6LinkPlan          `json:"ipv6,omitempty"`
}

type completeOutboundStartup struct {
	Snapshot     completeOutboundSnapshot `json:"snapshot"`
	Requirements outboundCapabilities     `json:"requirements"`
}

type completeOutboundReplace struct {
	Snapshot    completeOutboundSnapshot `json:"snapshot"`
	RequestDeny json.RawMessage          `json:"deny_net"`
	Restore     bool                     `json:"restore"`
}

func (snapshot completeOutboundSnapshot) prepare(existingLegacyPolicy bool) (outboundPolicy, outboundCapabilities, error) {
	var required outboundCapabilities
	if !validOutboundRevision(snapshot.Revision) || snapshot.Policy.AllowNet == nil || snapshot.Policy.DenyNet == nil {
		return outboundPolicy{}, required, fmt.Errorf("complete outbound snapshot requires both rule lists and a valid revision")
	}
	policy := outboundPolicy{Mode: snapshot.Policy.Mode, AllowNet: snapshot.Policy.AllowNet}
	if (snapshot.Admission == dualStackAdmission) != (snapshot.IPv6 != nil) {
		return outboundPolicy{}, required, fmt.Errorf("dual-stack admission must include its IPv6 link plan")
	}
	if snapshot.IPv6 != nil {
		if _, err := snapshot.IPv6.prefix(); err != nil {
			return outboundPolicy{}, required, err
		}
	}
	switch snapshot.Admission {
	case legacyAdmission:
		if len(snapshot.Policy.DenyNet) != 0 || (!existingLegacyPolicy && len(policy.AllowNet) > legacyOutboundRuleLimit) {
			return outboundPolicy{}, required, fmt.Errorf("legacy admission cannot enforce complete outbound policy")
		}
		return policy, required, policy.validate()
	case extendedAdmission, dualStackAdmission:
		compiled, err := compileExtendedOutboundPolicy(policy.Mode, policy.AllowNet, snapshot.Policy.DenyNet)
		if err != nil {
			return outboundPolicy{}, required, err
		}
		required = outboundCapabilities{
			Admission:  true,
			Deny:       len(compiled.deny) > 0,
			Capacity:   len(compiled.allow) > legacyOutboundRuleLimit || len(compiled.deny) > legacyOutboundRuleLimit,
			NativeIPv6: snapshot.IPv6 != nil,
		}
		for _, rules := range [][]outboundRule{compiled.allow, compiled.deny} {
			for _, rule := range rules {
				if rule.prefix.IsValid() && !rule.prefix.Addr().Is4() && !required.NativeIPv6 {
					return outboundPolicy{}, required, fmt.Errorf("native IPv6 outbound rules are unavailable")
				}
				required.Port = required.Port || rule.port != 0
			}
		}
		if !canonicalRulesMatch(compiled.allow, policy.AllowNet) || !canonicalRulesMatch(compiled.deny, snapshot.Policy.DenyNet) {
			return outboundPolicy{}, required, fmt.Errorf("complete outbound snapshot rules must be canonical")
		}
		policy.complete, policy.compiled, policy.required = &snapshot, compiled, required
		return policy, required, nil
	default:
		return outboundPolicy{}, required, fmt.Errorf("unknown outbound admission mode %q", snapshot.Admission)
	}
}

func canonicalRulesMatch(rules []outboundRule, values []string) bool {
	return len(rules) == len(values) && slices.EqualFunc(rules, values, func(rule outboundRule, value string) bool {
		return rule.canonical == value
	})
}

func decodeOutboundJSON(input []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("expected one outbound JSON value")
	}
	return nil
}

func decodeGvproxyStartup(input []byte) (GvproxyConfig, outboundPolicy, error) {
	var config GvproxyConfig
	var version struct {
		Outbound json.RawMessage `json:"outbound_v1"`
	}
	if err := json.Unmarshal(input, &version); err != nil {
		return config, outboundPolicy{}, err
	}
	if version.Outbound == nil {
		if err := json.Unmarshal(input, &config); err != nil {
			return config, outboundPolicy{}, err
		}
		mode := "enabled"
		if config.OutboundDisabled {
			mode = "disabled"
		}
		err := config.prepareGuard()
		return config, outboundPolicy{Mode: mode, AllowNet: config.AllowNet}, err
	}
	var envelope struct {
		Config   GvproxyConfig           `json:"config"`
		Outbound completeOutboundStartup `json:"outbound_v1"`
	}
	if err := decodeOutboundJSON(input, &envelope); err != nil {
		return config, outboundPolicy{}, err
	}
	policy, required, err := envelope.Outbound.Snapshot.prepare(true)
	if err != nil {
		return config, outboundPolicy{}, err
	}
	if !envelope.Outbound.Requirements.contains(required) || !supportedOutboundCapabilities().contains(envelope.Outbound.Requirements) {
		return config, outboundPolicy{}, fmt.Errorf("unsupported outbound startup requirements")
	}
	config = envelope.Config
	config.OutboundRevision = envelope.Outbound.Snapshot.Revision
	if plan := envelope.Outbound.Snapshot.IPv6; plan != nil {
		prefix, _ := plan.prefix()
		config.ipv6Gateway = &prefix
	}
	err = config.prepareGuard()
	return config, policy, err
}

func (snapshot *outboundSnapshot) completeSnapshot() completeOutboundSnapshot {
	if complete := snapshot.policy.complete; complete != nil {
		return *complete
	}
	return completeOutboundSnapshot{
		Revision: snapshot.revision, Admission: legacyAdmission,
		Policy: completeOutboundPolicy{Mode: snapshot.policy.Mode, AllowNet: snapshot.policy.AllowNet, DenyNet: []string{}},
	}
}

func (p *outboundPolicyController) serveCompleteStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	current := p.active.Load()
	if current.extended != nil && current.policy.complete == nil {
		http.Error(w, "outbound snapshot has no complete revision identity", http.StatusNotImplemented)
		return
	}
	snapshot := current.completeSnapshot()
	capabilities := p.capabilities
	capabilities.NativeIPv6 = snapshot.IPv6 != nil
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Snapshot     completeOutboundSnapshot `json:"snapshot"`
		State        string                   `json:"application_state"`
		Capabilities outboundCapabilities     `json:"capabilities"`
	}{snapshot, current.state, capabilities})
}

func (p *outboundPolicyController) replaceComplete(w http.ResponseWriter, r *http.Request, request completeOutboundReplace, current *outboundSnapshot) {
	if r.URL.Path != outboundSnapshotPath {
		http.Error(w, "complete policy requires the snapshot resource", http.StatusBadRequest)
		return
	}
	revision, status, err := revisionForOutboundUpdate(r, current.revision)
	if err != nil {
		http.Error(w, err.Error(), status)
		return
	}
	policy, requirements, err := request.Snapshot.prepare(request.Restore)
	if err != nil || revision != request.Snapshot.Revision {
		http.Error(w, "invalid complete outbound candidate", http.StatusBadRequest)
		return
	}
	previous := current.completeSnapshot()
	if !sameIPv6Plan(previous.IPv6, request.Snapshot.IPv6) {
		http.Error(w, "outbound replacement must retain the installed IPv6 link plan", http.StatusConflict)
		return
	}
	requirements = requirements.union(current.policy.required)
	requirements.Admission = requirements.Admission || current.extended != nil
	if request.RequestDeny != nil {
		var deny []string
		err := json.Unmarshal(request.RequestDeny, &deny)
		compiled, compileErr := compileOutboundRules("deny_net", deny)
		if err != nil || deny == nil || len(deny) > maxOutboundRules || compileErr != nil || !canonicalRulesMatch(compiled, request.Snapshot.Policy.DenyNet) {
			http.Error(w, "invalid complete outbound deny request", http.StatusBadRequest)
			return
		}
		requirements.Deny = true
	} else if !request.Restore && (len(previous.Policy.DenyNet) != 0 || len(request.Snapshot.Policy.DenyNet) != 0) {
		http.Error(w, "deny_net must be supplied when replacing active denies", http.StatusBadRequest)
		return
	}
	if !request.Restore && current.extended != nil && request.Snapshot.Admission == legacyAdmission {
		http.Error(w, "ordinary replacement must retain extended outbound admission", http.StatusConflict)
		return
	}
	if !p.capabilities.contains(requirements) {
		http.Error(w, "unsupported complete outbound policy capability", http.StatusNotImplemented)
		return
	}
	if err := p.apply(policy, revision); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", outboundETag(revision))
	_ = json.NewEncoder(w).Encode(p.active.Load().completeSnapshot())
}
