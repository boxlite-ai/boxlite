package boxlite

import (
	"context"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// SetOutboundNetwork replaces policy without starting a stopped box.
func (c *Client) SetOutboundNetwork(ctx context.Context, boxID string, policy boxlite.OutboundNetworkSpec) error {
	if err := (dto.OutboundNetworkPolicy{Mode: policy.Mode, AllowNet: policy.AllowNet}).Validate(); err != nil {
		return err
	}
	info, err := c.runtime.GetInfo(ctx, boxID)
	if err != nil {
		return err
	}
	if !guestDialable(info.State) {
		return &boxlite.Error{Code: boxlite.ErrInvalidState, Message: "outbound policy updates require a running box"}
	}
	box, err := c.getOrFetchBox(ctx, boxID)
	if err != nil {
		return err
	}
	network, err := box.Network()
	if err != nil {
		return err
	}
	defer network.Close()
	return network.UpdateOutbound(ctx, policy)
}
