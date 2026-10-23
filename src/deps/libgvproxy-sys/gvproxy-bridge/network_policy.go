package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

type outboundPolicy struct {
	Mode     string   `json:"mode"`
	AllowNet []string `json:"allow_net"`
}

// One controller owns policy replacement for both transports and the NIC.
// Forwarders capture immutable filters, so established flows keep their policy.
type outboundPolicyController struct {
	mu      sync.Mutex
	current outboundPolicy
	vn      *virtualnetwork.VirtualNetwork
	config  *types.Configuration
	guestIP string
	stack   *stack.Stack
	nic     tcpip.NICID
	ca      *BoxCA
	secrets *SecretHostMatcher
}

func newOutboundPolicyController(vn *virtualnetwork.VirtualNetwork, config *types.Configuration, guestIP string, ca *BoxCA, secrets *SecretHostMatcher, initial outboundPolicy) (*outboundPolicyController, error) {
	if initial.AllowNet == nil {
		initial.AllowNet = []string{}
	}
	s, err := stackOf(vn)
	if err != nil {
		return nil, err
	}
	nics := s.NICInfo()
	if len(nics) != 1 {
		return nil, fmt.Errorf("policy updates require one guest NIC, got %d", len(nics))
	}
	p := &outboundPolicyController{vn: vn, config: config, guestIP: guestIP, stack: s, ca: ca, secrets: secrets, current: initial}
	for id := range nics {
		p.nic = id
	}
	if len(initial.AllowNet) > 0 || secrets != nil || initial.Mode == "disabled" {
		if err := p.apply(initial); err != nil {
			return nil, err
		}
	}
	return p, nil
}

func (p *outboundPolicyController) apply(policy outboundPolicy) error {
	filter := NewAllowNetFilter(policy.AllowNet, p.config.GatewayIP, p.guestIP)
	dialer, err := newEgressDialer(filter, p.config.Subnet)
	if err != nil {
		return err
	}
	if err := installAllowNetHandlers(p.vn, p.config, p.config.Ec2MetadataAccess, filter, dialer, p.ca, p.secrets); err != nil {
		return err
	}
	var nicErr tcpip.Error
	if policy.Mode == "disabled" {
		nicErr = p.stack.DisableNIC(p.nic)
	} else {
		nicErr = p.stack.EnableNIC(p.nic)
	}
	if nicErr != nil {
		return fmt.Errorf("change guest NIC state: %s", nicErr)
	}
	if policy.AllowNet == nil {
		policy.AllowNet = []string{}
	}
	p.current = policy
	return nil
}

func (p *outboundPolicyController) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		var policy outboundPolicy
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&policy); err != nil {
			http.Error(w, "invalid outbound policy", http.StatusBadRequest)
			return
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			http.Error(w, "expected one outbound policy", http.StatusBadRequest)
			return
		}
		if err := policy.validate(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := p.apply(policy); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		w.Header().Set("Allow", "GET, PUT")
		http.Error(w, "GET or PUT required", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(p.current)
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
