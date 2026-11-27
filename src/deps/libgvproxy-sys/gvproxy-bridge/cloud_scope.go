package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

const cloudScopeStatus = "/network/cloud-scope"

var (
	gcpDNS           = netip.MustParseAddrPort("169.254.169.254:53")
	gcpPrivateAccess = netip.MustParsePrefix("199.36.153.8/30")
)

// Cloud scope comes from the Runner's deployment, independently of Box policy.
type cloudScope struct {
	Version         int    `json:"version"`
	Stage           string `json:"stage"`
	Box             string `json:"box"`
	Instance        string `json:"instance"`
	Runner          string `json:"runner"`
	RunnerIPv6      string `json:"runner_ipv6,omitempty"`
	CloudRun        string `json:"cloud_run"`
	ManagedProxy    string `json:"managed_proxy"`
	GKEPods         string `json:"gke_pods"`
	GKEServices     string `json:"gke_services"`
	PrivateServices string `json:"private_services"`
}

func (scope *cloudScope) UnmarshalJSON(data []byte) error {
	type wireScope cloudScope
	return decodeOutboundJSON(data, (*wireScope)(scope))
}

func (scope cloudScope) prefixes() ([]netip.Prefix, error) {
	if scope.Version != 1 || scope.Stage == "" || scope.Box == "" {
		return nil, fmt.Errorf("Cloud scope requires a supported version, stage, and Box identity")
	}
	if decoded, err := hex.DecodeString(scope.Instance); err != nil || len(decoded) != 16 {
		return nil, fmt.Errorf("Cloud scope requires a launch instance identity")
	}
	var prefixes []netip.Prefix
	for _, value := range []string{scope.Runner, scope.CloudRun, scope.ManagedProxy, scope.GKEPods, scope.GKEServices, scope.PrivateServices} {
		prefix, err := netip.ParsePrefix(value)
		if err != nil || !prefix.Addr().Is4() || prefix.Bits() == 0 || prefix != prefix.Masked() {
			return nil, fmt.Errorf("Cloud scope requires canonical IPv4 ranges for every managed resource")
		}
		prefixes = append(prefixes, prefix)
	}
	if scope.RunnerIPv6 != "" {
		prefix, err := netip.ParsePrefix(scope.RunnerIPv6)
		if err != nil || prefix.Bits() != 64 || prefix != prefix.Masked() ||
			prefix.String() != scope.RunnerIPv6 || !globalEgressIPv6(prefix.Addr()) {
			return nil, fmt.Errorf("Cloud scope requires a canonical public IPv6 /64 for the Runner")
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}

func cloudLocalPrefixes() ([]netip.Prefix, error) {
	interfaces, err := net.InterfaceAddrs()
	if err != nil {
		return nil, fmt.Errorf("read Cloud host addresses: %w", err)
	}
	var prefixes []netip.Prefix
	for _, address := range interfaces {
		literal, _, _ := strings.Cut(address.String(), "/")
		ip, err := netip.ParseAddr(literal)
		if err != nil {
			return nil, fmt.Errorf("invalid Cloud host interface address: %w", err)
		}
		ip = ip.WithZone("").Unmap()
		prefixes = append(prefixes, netip.PrefixFrom(ip, ip.BitLen()))
	}
	return prefixes, nil
}

func (config *GvproxyConfig) preparePlatformScope() error {
	guard, err := compilePlatformGuard(config.PlatformProtectedCIDRs, config.CloudScope != nil, config.Subnet)
	if err != nil {
		return err
	}
	if scope := config.CloudScope; scope != nil {
		prefixes, err := scope.prefixes()
		if err != nil {
			return err
		}
		local, err := cloudLocalPrefixes()
		if err != nil {
			return err
		}
		guard.protected = append(guard.protected, gcpPrivateAccess)
		guard.protected = append(guard.protected, prefixes...)
		guard.protected = append(guard.protected, local...)
		config.cloudResolvers = []netip.AddrPort{gcpDNS}
	}
	config.guard = guard
	return nil
}

func (scope cloudScope) status(w http.ResponseWriter, r *http.Request, policy *outboundPolicyController) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	current := policy.active.Load()
	plan := current.completeSnapshot().IPv6
	qualified := plan != nil && current.state == "confirmed" && policy.guard.supportsIPv6()
	ready := qualified && policy.ipv6LinkConfirmed.Load() &&
		(current.policy.Mode == "disabled" || policy.ipv6Ready.Load())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Scope         cloudScope    `json:"scope"`
		IPv6          *ipv6LinkPlan `json:"ipv6,omitempty"`
		IPv6Qualified bool          `json:"ipv6_qualified"`
		IPv6Ready     bool          `json:"ipv6_ready"`
	}{scope, plan, qualified, ready})
}

// A connected UDP socket asks the kernel to select a route and source without
// emitting a packet. Cloud native sockets use the verified source and device.
var cloudIPv6Probe = netip.MustParseAddrPort("[2001:4860:4860::8888]:53")

type cloudIPv6Uplink struct {
	device string
	source netip.Addr
}

func (scope cloudScope) ipv6Uplink(ctx context.Context) (cloudIPv6Uplink, error) {
	prefix, err := netip.ParsePrefix(scope.RunnerIPv6)
	if err != nil {
		return cloudIPv6Uplink{}, fmt.Errorf("Runner network has no public IPv6 declaration")
	}
	probe, err := (&net.Dialer{}).DialContext(ctx, "udp6", cloudIPv6Probe.String())
	if err != nil {
		return cloudIPv6Uplink{}, fmt.Errorf("look up Runner IPv6 route: %w", err)
	}
	source := probe.LocalAddr().(*net.UDPAddr).AddrPort().Addr()
	_ = probe.Close()
	if !prefix.Contains(source) {
		return cloudIPv6Uplink{}, fmt.Errorf("IPv6 route selects a source outside the Runner network")
	}
	return locateCloudIPv6Uplink(source, netip.MustParsePrefix(scope.Runner))
}

func locateCloudIPv6Uplink(source netip.Addr, runner netip.Prefix) (cloudIPv6Uplink, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return cloudIPv6Uplink{}, err
	}
	var uplink cloudIPv6Uplink
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			return cloudIPv6Uplink{}, err
		}
		var hasSource, onRunnerNetwork bool
		for _, address := range addresses {
			ip, _, _ := strings.Cut(address.String(), "/")
			addr, err := netip.ParseAddr(ip)
			if err != nil {
				return cloudIPv6Uplink{}, err
			}
			hasSource = hasSource || addr == source
			onRunnerNetwork = onRunnerNetwork || runner.Contains(addr.Unmap())
		}
		if hasSource && onRunnerNetwork {
			if uplink.device != "" {
				return cloudIPv6Uplink{}, fmt.Errorf("IPv6 source has an ambiguous Runner interface")
			}
			uplink = cloudIPv6Uplink{device: iface.Name, source: source}
		}
	}
	if uplink.device == "" {
		return cloudIPv6Uplink{}, fmt.Errorf("IPv6 route does not use the Runner interface")
	}
	return uplink, nil
}
