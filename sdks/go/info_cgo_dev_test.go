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
				Outbound:       NetworkDirectionInfo{Mode: NetworkModeEnabled, AllowNet: []string{"api.example.com"}},
				Inbound:        NetworkDirectionInfo{Mode: NetworkModeDisabled, AllowNet: []string{}},
				PublishedPorts: nil,
			},
		},
		{
			name: "publications resolved empty",
			got:  fixtures[2],
			want: &NetworkInfo{
				Outbound:       NetworkDirectionInfo{Mode: NetworkModeDisabled, AllowNet: []string{}},
				Inbound:        NetworkDirectionInfo{Mode: NetworkModeEnabled, AllowNet: []string{}},
				PublishedPorts: []PublishedPort{},
			},
		},
		{
			name: "populated values",
			got:  fixtures[3],
			want: &NetworkInfo{
				Outbound: NetworkDirectionInfo{Mode: NetworkModeEnabled, AllowNet: []string{"api.example.com"}},
				Inbound:  NetworkDirectionInfo{Mode: NetworkModeEnabled, AllowNet: []string{}},
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
