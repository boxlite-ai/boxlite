package main

import (
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

func (scope cloudScope) status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(scope)
}
