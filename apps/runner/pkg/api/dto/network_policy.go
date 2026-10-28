// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package dto

import (
	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/containerd/errdefs"
)

// OutboundNetworkPolicy is shared by create/recovery and runtime replacements.
type OutboundNetworkPolicy struct {
	Mode     boxlite.NetworkMode `json:"mode"`
	AllowNet []string            `json:"allow_net"`
}

func (p OutboundNetworkPolicy) Validate() error {
	if p.Mode != boxlite.NetworkModeEnabled && p.Mode != boxlite.NetworkModeDisabled {
		return errdefs.ErrInvalidArgument.WithMessage("invalid outbound mode")
	}
	if p.Mode == boxlite.NetworkModeDisabled && len(p.AllowNet) > 0 {
		return errdefs.ErrInvalidArgument.WithMessage("disabled outbound cannot include allow_net")
	}
	return nil
}
