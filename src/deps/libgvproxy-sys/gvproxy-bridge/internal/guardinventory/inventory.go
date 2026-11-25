package guardinventory

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	FileName     = "inventory.json"
	maxBytes     = 64 << 10
	readLimit    = 250 * time.Millisecond
	PollInterval = time.Second
	Freshness    = 1500 * time.Millisecond
)

type Document struct {
	Version           int       `json:"version"`
	Revision          string    `json:"revision"`
	ExpiresAt         time.Time `json:"expires_at"`
	ProtectedNetworks Networks  `json:"protected_networks"`
	ResolverEndpoints []string  `json:"resolver_endpoints"`
	TopologyDigest    string    `json:"topology_sha256,omitempty"`
	AbsentGroups      []string  `json:"absent_groups,omitempty"`
}

type Networks struct {
	Node         []string  `json:"node"`
	ControlPlane []string  `json:"control_plane"`
	Metadata     []string  `json:"metadata"`
	Services     []string  `json:"services"`
	Host         *[]string `json:"host,omitempty"`
	Translation  *[]string `json:"translation,omitempty"`
}

type Observation struct {
	Version        int
	TopologyDigest string
	Revision       string
	Digest         [sha256.Size]byte
	SampledAt      time.Time
	Expires        time.Time
	HostAddrs      []string
	Protected      []netip.Prefix
	Resolvers      []netip.AddrPort
}

func (inventory Observation) Deadline(expiry time.Time) time.Time {
	return minTime(inventory.SampledAt.Add(Freshness), expiry)
}

func minTime(first, second time.Time) time.Time {
	if first.Before(second) {
		return first
	}
	return second
}

// Sampler limits concurrent filesystem work even if an inventory read stalls.
type Sampler struct {
	RequireRoot          bool
	CheckAppliedTopology bool
	once                 sync.Once
	reading              chan struct{}
}

func Sample(parent context.Context, directory string) (Observation, error) {
	var sampler Sampler
	return sampler.Sample(parent, directory)
}

func (s *Sampler) Sample(parent context.Context, directory string) (Observation, error) {
	sampledAt := time.Now()
	ctx, cancel := context.WithDeadline(parent, sampledAt.Add(readLimit))
	defer cancel()
	s.once.Do(func() { s.reading = make(chan struct{}, 1) })
	select {
	case s.reading <- struct{}{}:
	case <-ctx.Done():
		return Observation{}, ctx.Err()
	}
	type result struct {
		inventory Observation
		err       error
	}
	results := make(chan result, 1)
	go func() {
		defer func() { <-s.reading }()
		inventory, err := read(directory, sampledAt, s.RequireRoot)
		if err == nil && inventory.Version == 2 && s.CheckAppliedTopology {
			var digest string
			digest, err = AppliedTopology(ctx)
			if err == nil && digest != inventory.TopologyDigest {
				err = fmt.Errorf("applied Cloud network topology differs from the inventory")
			}
		}
		results <- result{inventory, err}
	}()
	select {
	case <-ctx.Done():
		return Observation{}, ctx.Err()
	case result := <-results:
		if err := ctx.Err(); err != nil {
			return Observation{}, err
		}
		return result.inventory, result.err
	}
}

func read(directory string, sampledAt time.Time, requireRoot bool) (Observation, error) {
	dir, err := unix.Open(directory, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return Observation{}, fmt.Errorf("open Cloud inventory directory: %w", err)
	}
	defer unix.Close(dir)
	if requireRoot && !rootAuthority(dir) {
		return Observation{}, fmt.Errorf("Cloud inventory directory must be owned and writable only by root")
	}
	fd, err := unix.Openat(dir, FileName, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return Observation{}, fmt.Errorf("open Cloud inventory: %w", err)
	}
	file := os.NewFile(uintptr(fd), FileName)
	defer file.Close()
	if requireRoot && !rootAuthority(fd) {
		return Observation{}, fmt.Errorf("Cloud inventory must be owned and writable only by root")
	}
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxBytes {
		return Observation{}, fmt.Errorf("Cloud inventory must be a bounded regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return Observation{}, fmt.Errorf("read Cloud inventory: %w", err)
	}
	if len(raw) > maxBytes {
		return Observation{}, fmt.Errorf("Cloud inventory exceeds %d bytes", maxBytes)
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return Observation{}, fmt.Errorf("read host interface addresses: %w", err)
	}
	inventory, err := Parse(raw, sampledAt, addrs)
	if err != nil {
		return Observation{}, err
	}
	if inventory.Version == 2 && (!rootAuthority(dir) || !rootAuthority(fd)) {
		return Observation{}, fmt.Errorf("Cloud inventory v2 requires root-owned authority")
	}
	return inventory, nil
}

func rootAuthority(fd int) bool {
	var info unix.Stat_t
	return unix.Fstat(fd, &info) == nil && info.Uid == 0 && info.Mode&0o022 == 0
}

func Parse(raw []byte, sampledAt time.Time, addrs []net.Addr) (Observation, error) {
	var document Document
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return Observation{}, fmt.Errorf("invalid Cloud inventory JSON: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return Observation{}, fmt.Errorf("expected one Cloud inventory JSON record")
	}
	if (document.Version != 1 && document.Version != 2) || !validRevision(document.Revision) || !sampledAt.Before(document.ExpiresAt) {
		return Observation{}, fmt.Errorf("Cloud inventory requires a supported version, a valid revision, and future expiry")
	}
	if document.Version == 1 && (document.TopologyDigest != "" || document.AbsentGroups != nil ||
		document.ProtectedNetworks.Host != nil || document.ProtectedNetworks.Translation != nil) {
		return Observation{}, fmt.Errorf("Cloud inventory v2 fields require version 2")
	}
	resolvers, err := ResolverEndpoints(document.ResolverEndpoints)
	if err != nil {
		return Observation{}, err
	}
	for i, endpoint := range resolvers {
		document.ResolverEndpoints[i] = endpoint.String()
	}
	document.ExpiresAt = document.ExpiresAt.UTC()
	inventory := Observation{
		Version: document.Version, TopologyDigest: document.TopologyDigest,
		Revision: document.Revision, SampledAt: sampledAt, Resolvers: resolvers,
		Expires: sampledAt.Add(document.ExpiresAt.Sub(sampledAt)),
	}
	groups := []networkGroup{
		{"node", &document.ProtectedNetworks.Node}, {"control_plane", &document.ProtectedNetworks.ControlPlane},
		{"metadata", &document.ProtectedNetworks.Metadata}, {"services", &document.ProtectedNetworks.Services},
	}
	if document.Version == 2 {
		if !validTopologyDigest(document.TopologyDigest) {
			return Observation{}, fmt.Errorf("Cloud inventory v2 requires the applied topology SHA-256")
		}
		groups = append(groups, networkGroup{"host", document.ProtectedNetworks.Host},
			networkGroup{"translation", document.ProtectedNetworks.Translation})
		slices.Sort(document.AbsentGroups)
	}
	inventory.Protected, err = protectedNetworks(groups, document.Version, document.AbsentGroups)
	if err != nil {
		return Observation{}, err
	}
	canonical, err := json.Marshal(document)
	if err != nil {
		return Observation{}, fmt.Errorf("encode canonical Cloud inventory: %w", err)
	}
	inventory.Digest = sha256.Sum256(canonical)
	for _, addr := range addrs {
		var ip net.IP
		switch addr := addr.(type) {
		case *net.IPNet:
			ip = addr.IP
		case *net.IPAddr:
			ip = addr.IP
		}
		address, ok := netip.AddrFromSlice(ip)
		if !ok {
			return Observation{}, fmt.Errorf("invalid host interface address")
		}
		address = address.Unmap()
		inventory.HostAddrs = append(inventory.HostAddrs, address.String())
		if address.Is4() || document.Version == 2 {
			inventory.Protected = append(inventory.Protected, netip.PrefixFrom(address, address.BitLen()))
		}
	}
	slices.Sort(inventory.HostAddrs)
	inventory.HostAddrs = slices.Compact(inventory.HostAddrs)
	return inventory, nil
}

func validRevision(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func IPv4Prefixes(values []string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for i, value := range values {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("invalid platform-protected CIDR at index %d", i)
		}
		address, bits := prefix.Addr(), prefix.Bits()
		if address.Is4In6() && bits >= 96 {
			address, bits = address.Unmap(), bits-96
		}
		if !address.Is4() {
			return nil, fmt.Errorf("platform-protected CIDR at index %d must represent an IPv4 range", i)
		}
		prefixes = append(prefixes, netip.PrefixFrom(address, bits).Masked())
	}
	return prefixes, nil
}

func ResolverEndpoints(values []string) ([]netip.AddrPort, error) {
	if len(values) == 0 {
		return nil, fmt.Errorf("Cloud DNS requires at least one resolver endpoint")
	}
	endpoints := make([]netip.AddrPort, 0, len(values))
	for index, value := range values {
		endpoint, err := netip.ParseAddrPort(value)
		address := endpoint.Addr().Unmap()
		if err != nil || endpoint.Addr().Zone() != "" || !address.Is4() || endpoint.Port() == 0 ||
			address.IsUnspecified() || address.IsMulticast() ||
			address == netip.AddrFrom4([4]byte{255, 255, 255, 255}) {
			return nil, fmt.Errorf("invalid Cloud DNS resolver endpoint at index %d", index)
		}
		endpoints = append(endpoints, netip.AddrPortFrom(address, endpoint.Port()))
	}
	return endpoints, nil
}
