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

func TestCBoxInfoToGoCarriesTheMainCommandExitCode(t *testing.T) {
	fixtures := cBoxInfoExitCodeTestFixtures()
	tests := []struct {
		name string
		got  *int
		want *int
	}{
		{name: "no exit code recorded", got: fixtures[0]},
		// A clean exit and an unrecorded one would be the same C int; only the
		// pointer being non-null separates them, which is why it is a pointer.
		{name: "main command succeeded", got: fixtures[1], want: intPtr(0)},
		{name: "main command failed", got: fixtures[2], want: intPtr(42)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			switch {
			case tt.want == nil && tt.got != nil:
				t.Fatalf("ExitCode = %d, want nil", *tt.got)
			case tt.want != nil && tt.got == nil:
				t.Fatalf("ExitCode = nil, want %d", *tt.want)
			case tt.want != nil && *tt.got != *tt.want:
				t.Fatalf("ExitCode = %d, want %d", *tt.got, *tt.want)
			}
		})
	}
}

func intPtr(v int) *int { return &v }

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
