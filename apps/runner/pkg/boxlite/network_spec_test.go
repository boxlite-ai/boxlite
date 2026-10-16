// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"encoding/json"
	"log/slog"
	"reflect"
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

func TestNetworkSpecReadsOutboundPolicy(t *testing.T) {
	enabled, disabled := true, false

	tests := []struct {
		name string
		dto  dto.CreateBoxDTO
		want boxlite.NetworkSpec
	}{
		{
			name: "outbound enabled with an allowlist",
			dto:  dto.CreateBoxDTO{OutboundEnabled: &enabled, OutboundAllowNet: []string{"api.openai.com", " ", "10.0.0.0/8"}},
			want: boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled, AllowNet: []string{"api.openai.com", "10.0.0.0/8"}},
		},
		{
			name: "outbound enabled without an allowlist",
			dto:  dto.CreateBoxDTO{OutboundEnabled: &enabled},
			want: boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled},
		},
		{
			name: "outbound disabled ignores the allowlist",
			dto:  dto.CreateBoxDTO{OutboundEnabled: &disabled, OutboundAllowNet: []string{"api.openai.com"}},
			want: boxlite.NetworkSpec{Mode: boxlite.NetworkModeDisabled},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := networkSpec(test.dto)
			if err != nil {
				t.Fatalf("networkSpec() error = %v", err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("networkSpec() = %+v, want %+v", got, test.want)
			}
		})
	}
}

// A payload without outboundEnabled, such as a v2 job queued by an API that
// predates it, must be refused rather than started with a guessed policy.
func TestNetworkSpecRejectsMissingOutboundPolicy(t *testing.T) {
	var createDto dto.CreateBoxDTO
	payload := `{"id":"box-1","image":"base","networkBlockAll":true,"networkAllowList":"10.0.0.0/8"}`
	if err := json.Unmarshal([]byte(payload), &createDto); err != nil {
		t.Fatal(err)
	}

	_, err := networkSpec(createDto)
	if !errdefs.IsInvalidArgument(err) {
		t.Fatalf("networkSpec() error = %v, want an invalid-argument error", err)
	}
}

// Create checks the policy before it mounts volumes or creates the box, so a
// rejected request leaves nothing behind. A nil runtime would panic past it.
func TestCreateRejectsMissingOutboundPolicyBeforeSideEffects(t *testing.T) {
	_, _, err := (&Client{}).Create(t.Context(), dto.CreateBoxDTO{Id: "box-1", Image: "base"})
	if !errdefs.IsInvalidArgument(err) {
		t.Fatalf("Create() error = %v, want an invalid-argument error", err)
	}
}

// RecoverBox destroys the old box before recreating it, so the policy check
// must come first. A nil runtime would panic in Destroy.
func TestRecoverRejectsMissingOutboundPolicyBeforeDestroy(t *testing.T) {
	err := (&Client{logger: slog.Default()}).RecoverBox(t.Context(), "box-1", dto.RecoverBoxDTO{OsUser: "root"})
	if !errdefs.IsInvalidArgument(err) {
		t.Fatalf("RecoverBox() error = %v, want an invalid-argument error", err)
	}
}
