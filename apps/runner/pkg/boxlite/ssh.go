package boxlite

import (
	"context"
	"fmt"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// SSHConfigure replaces a running box's guest SSH configuration, exactly once.
//
// A box that is not running is refused with ErrBoxNotRunning rather than
// booted (see runningBox): the API wakes a box first when its auto-resume
// policy allows, so the control plane stays the only path that starts one.
// The guest restarts its listener on every accepted call, so nothing here
// retries it.
func (c *Client) SSHConfigure(ctx context.Context, boxID string, config boxlite.SSHConfig) (*boxlite.SSHStatus, error) {
	bx, err := c.runningBox(ctx, boxID)
	if err != nil {
		return nil, err
	}
	return bx.SSH().Configure(ctx, config)
}

// SSHEnable enables saved configuration without booting the box or restarting
// a healthy listener.
func (c *Client) SSHEnable(ctx context.Context, boxID string) (*boxlite.SSHStatus, error) {
	bx, err := c.runningBox(ctx, boxID)
	if err != nil {
		return nil, err
	}
	return bx.SSH().Enable(ctx)
}

// SSHStatus reports a box's guest SSH listener without starting the box.
// A stopped or never-started box has no live listener, regardless of saved SSH
// intent. Return disabled without fetching a handle, which would be evicted
// and leaked on every observation of an idle box (see evictBox).
func (c *Client) SSHStatus(ctx context.Context, boxID string) (*boxlite.SSHStatus, error) {
	info, err := c.runtime.GetInfo(ctx, boxID)
	if err != nil {
		return nil, fmt.Errorf("read state of box %s: %w", boxID, err)
	}
	switch info.State {
	case boxlite.StateStopped, boxlite.StateConfigured:
		return &boxlite.SSHStatus{}, nil
	case boxlite.StateRunning:
		bx, err := c.getOrFetchBox(ctx, boxID)
		if err != nil {
			return nil, err
		}
		return bx.SSH().Status(ctx)
	default:
		return nil, fmt.Errorf("%w: %s is %s", ErrBoxNotRunning, boxID, info.State)
	}
}

// SSHDisable stops SSH on a running box. Repeated calls are supported, but
// an idle box is refused without changing its saved SSH intent or booting it.
func (c *Client) SSHDisable(ctx context.Context, boxID string) (*boxlite.SSHStatus, error) {
	bx, err := c.runningBox(ctx, boxID)
	if err != nil {
		return nil, err
	}
	return bx.SSH().Disable(ctx)
}
