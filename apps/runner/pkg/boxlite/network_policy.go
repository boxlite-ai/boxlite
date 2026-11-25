package boxlite

import (
	"context"
	"encoding/json"
	"strings"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// SetOutboundNetwork replaces policy without starting a stopped box.
func (c *Client) SetOutboundNetwork(ctx context.Context, boxID string, policy boxlite.OutboundNetworkSpec) error {
	if err := (dto.OutboundNetworkPolicy{Mode: policy.Mode, AllowNet: policy.AllowNet}).Validate(); err != nil {
		return err
	}
	info, err := c.nativeBoxInfo(ctx, boxID)
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

// OutboundSnapshot reads durable policy without booting a stopped box.
func (c *Client) OutboundSnapshot(ctx context.Context, boxID string) (boxlite.OutboundSnapshot, error) {
	network, err := c.outboundNetwork(ctx, boxID)
	if err != nil {
		return boxlite.OutboundSnapshot{}, err
	}
	defer network.Close()
	return network.OutboundSnapshot(ctx)
}

// OutboundStatus compares durable and live state without changing either.
func (c *Client) OutboundStatus(ctx context.Context, boxID string) (boxlite.OutboundStatus, error) {
	network, err := c.outboundNetwork(ctx, boxID)
	if err != nil {
		return boxlite.OutboundStatus{}, err
	}
	defer network.Close()
	return network.OutboundStatus(ctx)
}

// PrepareOutboundCreate checks the local Runtime before Cloud reserves a create.
func (c *Client) PrepareOutboundCreate(ctx context.Context, revision string, policy json.RawMessage) (boxlite.PreparedOutboundCreate, error) {
	return c.runtime.PrepareOutboundCreate(ctx, revision, policy)
}

// CompleteOutboundSnapshot reads the complete durable policy and admission mode.
func (c *Client) CompleteOutboundSnapshot(ctx context.Context, boxID string) (boxlite.CompleteOutboundSnapshot, error) {
	network, err := c.outboundNetwork(ctx, boxID)
	if err != nil {
		return boxlite.CompleteOutboundSnapshot{}, err
	}
	defer network.Close()
	return network.CompleteOutboundSnapshot(ctx)
}

// CompleteOutboundStatus compares complete durable and live state.
func (c *Client) CompleteOutboundStatus(ctx context.Context, boxID string) (boxlite.CompleteOutboundStatus, error) {
	network, err := c.outboundNetwork(ctx, boxID)
	if err != nil {
		return boxlite.CompleteOutboundStatus{}, err
	}
	defer network.Close()
	return network.CompleteOutboundStatus(ctx)
}

func (c *Client) HostedOutbound(ctx context.Context, boxID string, command json.RawMessage) (boxlite.HostedOutboundReceipt, error) {
	operation, err := c.lockCheckpointTarget(ctx, boxID)
	if err != nil {
		return boxlite.HostedOutboundReceipt{}, err
	}
	defer operation.Close()
	info, err := c.nativeBoxInfo(ctx, boxID)
	if err != nil {
		return boxlite.HostedOutboundReceipt{}, err
	}
	if info.Name != boxID || strings.HasPrefix(boxID, "checkpoint-") {
		return boxlite.HostedOutboundReceipt{}, &boxlite.Error{Code: boxlite.ErrInvalidArgument, Message: "hosted outbound requires the logical box ID"}
	}
	network, err := c.outboundNetwork(ctx, boxID)
	if err != nil {
		return boxlite.HostedOutboundReceipt{}, err
	}
	defer network.Close()
	return network.HostedOutbound(ctx, command)
}

// ReplaceOutboundSnapshot preserves the initiating coordinator's candidate ID.
func (c *Client) ReplaceOutboundSnapshot(ctx context.Context, boxID, expected string, candidate boxlite.OutboundSnapshot) (boxlite.OutboundReplaceOutcome, error) {
	if !boxlite.ValidOutboundRevision(expected) || !boxlite.ValidOutboundRevision(candidate.Revision) || candidate.Revision == expected || candidate.Revision == "initial" {
		return "", &boxlite.Error{Code: boxlite.ErrInvalidArgument, Message: "invalid outbound revision precondition or candidate"}
	}
	if err := (dto.OutboundNetworkPolicy{Mode: candidate.Policy.Mode, AllowNet: candidate.Policy.AllowNet}).Validate(); err != nil {
		return "", err
	}
	info, err := c.nativeBoxInfo(ctx, boxID)
	if err != nil {
		return "", err
	}
	if !guestDialable(info.State) {
		return "", &boxlite.Error{Code: boxlite.ErrInvalidState, Message: "outbound policy updates require a running box"}
	}
	network, err := c.outboundNetwork(ctx, boxID)
	if err != nil {
		return "", err
	}
	defer network.Close()
	return network.ReplaceOutboundSnapshot(ctx, expected, candidate)
}

func (c *Client) outboundNetwork(ctx context.Context, boxID string) (*boxlite.Network, error) {
	id, err := c.nativeBoxID(boxID)
	if err != nil {
		return nil, err
	}
	box, err := c.runtime.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	// Network owns its native handle independently; this request owns only this
	// Box wrapper, so releasing it cannot invalidate borrowed lifecycle handles.
	defer box.Close()
	return box.Network()
}
