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
				Outbound:       OutboundNetworkInfo{Mode: NetworkModeEnabled, AllowNet: []string{"api.example.com"}},
				Inbound:        InboundNetworkInfo{Mode: NetworkModeDisabled, AllowNet: []string{}},
				Mode:           NetworkModeEnabled,
				AllowNet:       []string{"api.example.com"},
				PublishedPorts: nil,
			},
		},
		{
			name: "publications resolved empty",
			got:  fixtures[2],
			want: &NetworkInfo{
				Outbound:       OutboundNetworkInfo{Mode: NetworkModeDisabled, AllowNet: []string{}},
				Inbound:        InboundNetworkInfo{Mode: NetworkModeEnabled, AllowNet: []string{}},
				Mode:           NetworkModeDisabled,
				AllowNet:       []string{},
				PublishedPorts: []PublishedPort{},
			},
		},
		{
			name: "populated values",
			got:  fixtures[3],
			want: &NetworkInfo{
				Outbound: OutboundNetworkInfo{Mode: NetworkModeEnabled, AllowNet: []string{"api.example.com"}},
				Inbound:  InboundNetworkInfo{Mode: NetworkModeEnabled, AllowNet: []string{}},
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

// TestCBoxInfoToGoCarriesTheResolvedImage checks the resolved image survives
// the hop into Go. Nothing else would notice it missing: a caller reading nil
// just never learns which build its box got.
func TestCBoxInfoToGoCarriesTheResolvedImage(t *testing.T) {
	known, unknown := cBoxInfoResolvedImageTestFixtures()
	want := &ResolvedImage{
		ManifestDigest: "sha256:0a7ed0d449b9318548e66674610d757de19b7645759f74b587b610b59d6b43fd",
		TotalLayerSize: 3974501,
	}
	if !reflect.DeepEqual(known.ResolvedImage, want) {
		t.Errorf("ResolvedImage = %+v, want %+v", known.ResolvedImage, want)
	}
	if unknown.ResolvedImage != nil {
		t.Errorf("a null native digest must read as nil, got %+v", unknown.ResolvedImage)
	}
}
