package main

import (
	"net"
	"testing"

	logrus "github.com/sirupsen/logrus"
	logrustest "github.com/sirupsen/logrus/hooks/test"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
)

func ipv4Addr(t *testing.T, s string) tcpip.Address {
	t.Helper()
	ip := net.ParseIP(s).To4()
	if ip == nil {
		t.Fatalf("not an IPv4 address: %q", s)
	}
	return tcpip.AddrFrom4Slice(ip)
}

func TestUDPDestinationAllowed_IPAndCIDRRules(t *testing.T) {
	filter := testFilter("1.2.3.4", "10.0.0.0/8")

	cases := []struct {
		dest string
		want bool
		why  string
	}{
		{"1.2.3.4", true, "exact IP rule"},
		{"10.1.2.3", true, "inside CIDR rule"},
		{"11.1.2.3", false, "outside every rule"},
		{"8.8.8.8", false, "unapproved resolver"},
		{"192.168.127.1", true, "gateway is always allowed"},
		{"192.168.127.254", false, "host alias NATs to host loopback, so it obeys the allowlist"},
	}

	for _, tc := range cases {
		if got := udpDestinationAllowed(ipv4Addr(t, tc.dest), filter); got != tc.want {
			t.Errorf("udpDestinationAllowed(%s) = %v, want %v (%s)", tc.dest, got, tc.want, tc.why)
		}
	}
}

// Hostname rules need SNI/Host inspection, which UDP cannot provide. A
// hostname-only allowlist must therefore deny UDP outright — otherwise a
// guest bypasses the rule by addressing the resolved IP directly.
func TestUDPDestinationAllowed_HostnameOnlyRulesDenyEverything(t *testing.T) {
	filter := testFilter("api.openai.com", "*.example.com")

	for _, dest := range []string{"1.2.3.4", "93.184.216.34", "8.8.8.8"} {
		if udpDestinationAllowed(ipv4Addr(t, dest), filter) {
			t.Errorf("udpDestinationAllowed(%s) = true, want false for a hostname-only allowlist", dest)
		}
	}

	// Internal addresses stay reachable so the box can still boot and resolve.
	if !udpDestinationAllowed(ipv4Addr(t, "192.168.127.1"), filter) {
		t.Error("gateway must stay reachable under a hostname-only allowlist")
	}
}

// Link-local is denied regardless of the allowlist: ec2MetadataAccess opens
// IMDS over TCP only, so a UDP hole there would be pure added egress.
func TestUDPDestinationAllowed_LinkLocalAndBroadcastDenied(t *testing.T) {
	filter := testFilter("169.254.0.0/16", "255.255.255.255")

	if udpDestinationAllowed(ipv4Addr(t, "169.254.169.254"), filter) {
		t.Error("link-local must be denied even when a CIDR rule covers it")
	}
	if udpDestinationAllowed(header.IPv4Broadcast, filter) {
		t.Error("broadcast must be denied even when an exact rule covers it")
	}
}

func TestBlockedDestinationLog_OneLinePerDestination(t *testing.T) {
	hook := logrustest.NewLocal(logrus.StandardLogger())
	defer hook.Reset()

	blocked := newBlockedDestinationLog()
	dest := ipv4Addr(t, "1.2.3.4")

	// Drops 2..9 are neither a new destination nor an order-of-magnitude
	// milestone, so they must stay silent.
	for i := 0; i < 5; i++ {
		blocked.note(dest, 53)
	}

	if got := len(hook.Entries); got != 1 {
		t.Fatalf("5 drops to one destination produced %d log lines, want 1", got)
	}
	if blocked.dropped != 5 {
		t.Errorf("dropped counter = %d, want 5", blocked.dropped)
	}
}

func TestBlockedDestinationLog_LogsEachNewDestination(t *testing.T) {
	hook := logrustest.NewLocal(logrus.StandardLogger())
	defer hook.Reset()

	blocked := newBlockedDestinationLog()
	blocked.note(ipv4Addr(t, "1.2.3.4"), 53)
	blocked.note(ipv4Addr(t, "1.2.3.4"), 443) // same IP, different port
	blocked.note(ipv4Addr(t, "5.6.7.8"), 53)

	if got := len(hook.Entries); got != 3 {
		t.Fatalf("3 distinct destinations produced %d log lines, want 3", got)
	}
}

func TestBlockedDestinationLog_BoundedByDestinationCap(t *testing.T) {
	hook := logrustest.NewLocal(logrus.StandardLogger())
	defer hook.Reset()

	blocked := newBlockedDestinationLog()
	// One drop per distinct port, past the cap. The milestone lines (drops
	// 1, 10, 100) coincide with new destinations, so they add no extra
	// entries; every drop past the cap must be silent.
	for port := 0; port < maxLoggedDestinations+64; port++ {
		blocked.note(ipv4Addr(t, "1.2.3.4"), uint16(port))
	}

	if got := len(hook.Entries); got != maxLoggedDestinations {
		t.Fatalf("logged %d lines for %d destinations, want the %d cap",
			got, maxLoggedDestinations+64, maxLoggedDestinations)
	}
	if blocked.dropped != uint64(maxLoggedDestinations+64) {
		t.Errorf("dropped counter = %d, want %d", blocked.dropped, maxLoggedDestinations+64)
	}
}

func TestBlockedDestinationLog_MilestoneKeepsFloodVisible(t *testing.T) {
	hook := logrustest.NewLocal(logrus.StandardLogger())
	defer hook.Reset()

	blocked := newBlockedDestinationLog()
	dest := ipv4Addr(t, "1.2.3.4")
	for i := 0; i < 100; i++ {
		blocked.note(dest, 53)
	}

	// Drops 1, 10 and 100 to a single destination: first-seen plus two
	// order-of-magnitude milestones.
	if got := len(hook.Entries); got != 3 {
		t.Fatalf("100 drops to one destination produced %d log lines, want 3", got)
	}
	if last := hook.LastEntry().Data["dropped_total"]; last != uint64(100) {
		t.Errorf("last line reported dropped_total=%v, want 100", last)
	}
}
