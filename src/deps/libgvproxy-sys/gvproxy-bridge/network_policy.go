package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

const (
	maxLegacyOutboundBody = 64 << 10
	// Allow the versioned framing around any policy accepted by the flat endpoint.
	maxCompleteOutboundBody = maxLegacyOutboundBody + (1 << 10)
)

type outboundPolicy struct {
	Mode     string   `json:"mode"`
	AllowNet []string `json:"allow_net"`
	tcp      *trustedTCPRules
	complete *completeOutboundSnapshot
	compiled *extendedOutboundPolicy
	required outboundCapabilities
}

type trustedTCPRules struct {
	allow, deny []string
}

type nicOperations interface {
	EnableNIC(tcpip.NICID) tcpip.Error
	DisableNIC(tcpip.NICID) tcpip.Error
}

// One controller owns policy replacement for both transports and the NIC.
// Forwarders capture immutable snapshots, so established flows keep their policy and transport.
type outboundPolicyController struct {
	mu           sync.Mutex
	active       atomic.Pointer[outboundSnapshot]
	config       *types.Configuration
	guard        platformGuard
	inventory    guardinventory.Observation
	resolve      resolveFunc
	guestIP      string
	stack        *stack.Stack
	nic          tcpip.NICID
	nicOps       nicOperations
	capabilities outboundCapabilities

	tcpInspectionSlots chan struct{}
	udpFlows           *udpFlowPool
}

func newOutboundPolicyController(ctx context.Context, vn *virtualnetwork.VirtualNetwork, config *types.Configuration, startup GvproxyConfig, ca *BoxCA, secrets *SecretHostMatcher, initial outboundPolicy, resolve resolveFunc) (*outboundPolicyController, error) {
	s, err := stackOf(vn)
	if err != nil {
		return nil, err
	}
	nics := s.NICInfo()
	if len(nics) != 1 {
		return nil, fmt.Errorf("policy updates require one guest NIC, got %d", len(nics))
	}
	p := &outboundPolicyController{
		config: config, guard: startup.guard, resolve: resolve, guestIP: startup.GuestIP, stack: s, nicOps: s,
		capabilities:       supportedOutboundCapabilities(),
		tcpInspectionSlots: make(chan struct{}, 10),
		udpFlows:           newUDPFlowPool(ctx),
	}
	for id := range nics {
		p.nic = id
	}
	initialRevision := startup.OutboundRevision
	if initialRevision == "" {
		initialRevision, err = newOutboundRevision()
		if err != nil {
			return nil, err
		}
	}
	if !validOutboundRevision(initialRevision) {
		return nil, fmt.Errorf("invalid initial outbound revision")
	}
	snapshot, err := p.compile(initial, initialRevision)
	if err != nil {
		return nil, err
	}
	p.publish(snapshot, "pending")
	if err := p.installOutboundModeGate(); err != nil {
		return nil, err
	}
	installOutboundHandlers(p.stack, config, p.active.Load, p.tcpInspectionSlots, p.udpFlows, ca, secrets)
	if initial.Mode == "disabled" {
		if err := p.nicOps.DisableNIC(p.nic); err != nil {
			return nil, fmt.Errorf("suspend initial guest NIC: %s", err)
		}
	}
	p.publish(snapshot, "confirmed")
	return p, nil
}

func (p *outboundPolicyController) apply(policy outboundPolicy, revision string) error {
	candidate, err := p.compile(policy, revision)
	if err != nil {
		return err
	}
	return p.applySnapshot(candidate)
}

func (p *outboundPolicyController) replaceTrustedTCP(mode string, rules trustedTCPRules, expected, revision string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	current := p.active.Load()
	if current.revision != expected || revision == expected || revision == "initial" || !validOutboundRevision(revision) {
		return fmt.Errorf("invalid outbound TCP replacement revision")
	}
	candidate := *current
	if err := candidate.setTCPPolicy(mode, rules); err != nil {
		return err
	}
	candidate.revision = revision
	return p.applySnapshot(&candidate)
}

// The caller holds the controller mutex across candidate preparation and publication.
func (p *outboundPolicyController) applySnapshot(candidate *outboundSnapshot) error {
	previous := p.active.Load()
	transition := previous
	var nicErr tcpip.Error
	if candidate.policy.Mode == "disabled" {
		transition = candidate
		p.publish(transition, "pending")
		nicErr = p.nicOps.DisableNIC(p.nic)
	} else {
		// Retain the disabled snapshot while the NIC is being enabled.
		p.publish(transition, "pending")
		if previous.policy.Mode == "disabled" {
			nicErr = p.nicOps.EnableNIC(p.nic)
		}
	}
	if nicErr != nil {
		p.publish(transition, "uncertain")
		return fmt.Errorf("change guest NIC state: %s", nicErr)
	}
	p.publish(candidate, "confirmed")
	return nil
}

func (p *outboundPolicyController) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == completeOutboundStatusPath {
		p.serveCompleteStatus(w, r)
		return
	}
	if r.URL.Path == outboundStatusPath {
		p.serveStatus(w, r)
		return
	}
	if r.URL.Path == outboundSnapshotPath {
		if r.Method != http.MethodPut {
			w.Header().Set("Allow", "PUT")
			http.Error(w, "PUT required", http.StatusMethodNotAllowed)
			return
		}
		if len(r.Header.Values(outboundRevisionHeader)) == 0 {
			http.Error(w, "snapshot replacement requires a candidate revision", http.StatusBadRequest)
			return
		}
	} else if r.URL.Path != "/network/outbound" {
		http.NotFound(w, r)
		return
	} else if len(r.Header.Values(outboundRevisionHeader)) != 0 {
		http.Error(w, "coordinator metadata requires the snapshot resource", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		p.mu.Lock()
		defer p.mu.Unlock()
		current := p.active.Load()
		var request struct {
			outboundPolicy
			Complete json.RawMessage `json:"outbound_v1"`
		}
		limit := int64(maxLegacyOutboundBody)
		if r.URL.Path == outboundSnapshotPath {
			limit = maxCompleteOutboundBody
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
		if err != nil || decodeOutboundJSON(body, &request) != nil {
			http.Error(w, "invalid outbound policy", http.StatusBadRequest)
			return
		}
		if request.Complete != nil {
			var complete completeOutboundReplace
			if request.Mode != "" || request.AllowNet != nil || decodeOutboundJSON(request.Complete, &complete) != nil {
				http.Error(w, "invalid complete outbound request", http.StatusBadRequest)
				return
			}
			p.replaceComplete(w, r, complete, current)
			return
		}
		if len(body) > maxLegacyOutboundBody {
			http.Error(w, "invalid outbound policy", http.StatusBadRequest)
			return
		}
		policy := request.outboundPolicy
		if err := policy.validate(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		revision, status, err := revisionForOutboundUpdate(r, current.revision)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}
		if current.extended != nil {
			http.Error(w, "extended TCP policy requires a complete trusted replacement", http.StatusConflict)
			return
		}
		if err := p.apply(policy, revision); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		w.Header().Set("Allow", "GET, PUT")
		http.Error(w, "GET or PUT required", http.StatusMethodNotAllowed)
		return
	}
	snapshot := p.active.Load()
	if snapshot.policy.complete != nil {
		http.Error(w, "outbound policy requires complete status", http.StatusNotImplemented)
		return
	}
	if snapshot.state != "confirmed" {
		http.Error(w, "outbound policy application is "+snapshot.state, http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", outboundETag(snapshot.revision))
	_ = json.NewEncoder(w).Encode(snapshot.policy)
}

func (p outboundPolicy) validate() error {
	if p.Mode != "enabled" && p.Mode != "disabled" {
		return fmt.Errorf("mode must be enabled or disabled")
	}
	if p.Mode == "disabled" && len(p.AllowNet) != 0 {
		return fmt.Errorf("disabled policy cannot include allow_net")
	}
	for _, rule := range p.AllowNet {
		// NewAllowNetFilter trims rules, and create accepts padded ones.
		rule = strings.TrimSpace(rule)
		if ip := net.ParseIP(rule); ip != nil && ip.To4() != nil {
			continue
		}
		if ip, _, err := net.ParseCIDR(rule); err == nil && ip.To4() != nil {
			continue
		}
		host := strings.TrimPrefix(rule, "*.")
		if host == "" || len(host) > 253 {
			return fmt.Errorf("invalid allow_net rule %q", rule)
		}
		if strings.Count(host, ".") == 3 && strings.Trim(host, "0123456789.") == "" {
			return fmt.Errorf("invalid IPv4 rule %q", rule)
		}
		for _, label := range strings.Split(host, ".") {
			if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
				return fmt.Errorf("invalid allow_net rule %q", rule)
			}
			for _, c := range label {
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
					return fmt.Errorf("invalid allow_net rule %q", rule)
				}
			}
		}
	}
	return nil
}
