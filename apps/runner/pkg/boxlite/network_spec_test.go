// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"encoding/json"
	"reflect"
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestNetworkSpecReadsOutboundPolicy(t *testing.T) {
	tests := []struct {
		name string
		dto  dto.CreateBoxDTO
		want boxlite.NetworkSpec
	}{
		{
			name: "outbound enabled with an allowlist",
			dto:  dto.CreateBoxDTO{OutboundEnabled: true, OutboundAllowNet: []string{"api.openai.com", " ", "10.0.0.0/8"}},
			want: boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled, AllowNet: []string{"api.openai.com", "10.0.0.0/8"}},
		},
		{
			name: "outbound enabled without an allowlist",
			dto:  dto.CreateBoxDTO{OutboundEnabled: true},
			want: boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled},
		},
		{
			name: "outbound disabled ignores the allowlist",
			dto:  dto.CreateBoxDTO{OutboundEnabled: false, OutboundAllowNet: []string{"api.openai.com"}},
			want: boxlite.NetworkSpec{Mode: boxlite.NetworkModeDisabled},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := networkSpec(test.dto); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("networkSpec() = %+v, want %+v", got, test.want)
			}
		})
	}
}

// A v2 job queued by an API that predates outboundEnabled carries only the
// removed networkBlockAll pair. The box it creates must get no egress, never
// full egress.
func TestPayloadWithoutOutboundPolicyBlocksEgress(t *testing.T) {
	var createDto dto.CreateBoxDTO
	payload := `{"id":"box-1","image":"base","networkBlockAll":true,"networkAllowList":"10.0.0.0/8"}`
	if err := json.Unmarshal([]byte(payload), &createDto); err != nil {
		t.Fatal(err)
	}

	if got := networkSpec(createDto); got.Mode != boxlite.NetworkModeDisabled {
		t.Fatalf("networkSpec() mode = %q, want %q", got.Mode, boxlite.NetworkModeDisabled)
	}
}
