//go:build boxlite_dev

package boxlite

import (
	"reflect"
	"testing"
)

func TestCNetworkInfoToGoTraversesNativeStruct(t *testing.T) {
	fixtures := cNetworkInfoTraversalTestFixtures()
	tests := []struct {
		name string
		got  *NetworkInfo
		want *NetworkInfo
	}{
		{name: "network unavailable", got: fixtures[0]},
		{
			name: "publications unresolved",
			got:  fixtures[1],
			want: &NetworkInfo{
				Mode:           NetworkModeEnabled,
				AllowNet:       []string{"api.example.com"},
				PublishedPorts: nil,
			},
		},
		{
			name: "publications resolved empty",
			got:  fixtures[2],
			want: &NetworkInfo{
				Mode:           NetworkModeDisabled,
				AllowNet:       []string{},
				PublishedPorts: []PublishedPort{},
			},
		},
		{
			name: "populated values",
			got:  fixtures[3],
			want: &NetworkInfo{
				Mode:     NetworkModeEnabled,
				AllowNet: []string{"api.example.com"},
				PublishedPorts: []PublishedPort{
					{
						GuestPort: 3000,
						HostIP:    "127.0.0.1",
						HostPort:  49152,
						Protocol:  PortProtocolTcp,
					},
					{
						GuestPort: 53,
						HostIP:    "::1",
						HostPort:  5353,
						Protocol:  PortProtocolUdp,
					},
				},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if !reflect.DeepEqual(test.got, test.want) {
				t.Fatalf("cNetworkInfoToGo() = %#v, want %#v", test.got, test.want)
			}
		})
	}
}

// TestCBoxInfoToGoTraversesExitCode checks that the has_exit_code flag, not the
// code's value, decides whether ExitCode is set — a recorded 0 is a successful
// workload, not an absent result.
func TestCBoxInfoToGoTraversesExitCode(t *testing.T) {
	fixtures := cBoxInfoExitCodeTestFixtures()
	zero, three := 0, 3
	tests := []struct {
		name string
		got  *int
		want *int
	}{
		{name: "no code recorded", got: fixtures[0]},
		{name: "nonzero exit code", got: fixtures[1], want: &three},
		{name: "zero exit code is not absence", got: fixtures[2], want: &zero},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if !reflect.DeepEqual(test.got, test.want) {
				t.Fatalf("cBoxInfoToGo().ExitCode = %v, want %v", test.got, test.want)
			}
		})
	}
}
