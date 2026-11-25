package guardinventory

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/netip"
	"slices"
	"strings"
)

type networkGroup struct {
	name  string
	cidrs *[]string
}

func validTopologyDigest(value string) bool {
	digest, err := hex.DecodeString(value)
	return err == nil && len(digest) == sha256.Size && value == strings.ToLower(value)
}

func protectedNetworks(groups []networkGroup, version int, absent []string) ([]netip.Prefix, error) {
	var protected []netip.Prefix
	emptyCount := 0
	for _, group := range groups {
		if group.cidrs == nil || *group.cidrs == nil {
			return nil, fmt.Errorf("Cloud inventory is missing protected network group %s", group.name)
		}
		values := *group.cidrs
		if version == 2 {
			attestedAbsent := slices.Contains(absent, group.name)
			if attestedAbsent != (len(values) == 0) {
				return nil, fmt.Errorf("Cloud inventory absence attestation disagrees with %s coverage", group.name)
			}
			if attestedAbsent {
				emptyCount++
			}
		}
		var prefixes []netip.Prefix
		var err error
		if version == 1 {
			prefixes, err = IPv4Prefixes(values)
		} else {
			prefixes, err = dualStackPrefixes(values)
		}
		if err != nil {
			return nil, fmt.Errorf("Cloud inventory network group %s: %w", group.name, err)
		}
		for i, prefix := range prefixes {
			values[i] = prefix.String()
		}
		slices.Sort(values)
		*group.cidrs = slices.Compact(values)
		protected = append(protected, prefixes...)
	}
	if len(absent) != emptyCount {
		return nil, fmt.Errorf("Cloud inventory absence attestation contains unknown or duplicated groups")
	}
	return protected, nil
}

func dualStackPrefixes(values []string) ([]netip.Prefix, error) {
	prefixes := make([]netip.Prefix, 0, len(values))
	for index, value := range values {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil || (prefix.Addr().Is4In6() && prefix.Bits() < 96) {
			return nil, fmt.Errorf("invalid protected CIDR at index %d", index)
		}
		if prefix.Addr().Is4In6() {
			prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}
