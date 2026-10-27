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

// SSHStatus reports a box's guest SSH listener without starting the box.
func (c *Client) SSHStatus(ctx context.Context, boxID string) (*boxlite.SSHStatus, error) {
	return c.observeSSH(ctx, boxID, (*boxlite.SSH).Status)
}

// SSHDisable stops a box's guest SSH listener without starting the box.
func (c *Client) SSHDisable(ctx context.Context, boxID string) (*boxlite.SSHStatus, error) {
	return c.observeSSH(ctx, boxID, (*boxlite.SSH).Disable)
}

// observeSSH runs an SSH call that must never boot the box.
//
// SSH lives in guest memory, so a stopped or never-started box has no listener
// and answers the disabled status from the runtime's persisted state. Fetching
// a handle for such a box would evict and leak one per call (see evictBox). A
// running box is asked through its handle; Status and Disable leave a handle
// whose box has meanwhile stopped unbooted.
func (c *Client) observeSSH(
	ctx context.Context,
	boxID string,
	call func(*boxlite.SSH, context.Context) (*boxlite.SSHStatus, error),
) (*boxlite.SSHStatus, error) {
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
		return call(bx.SSH(), ctx)
	default:
		return nil, fmt.Errorf("%w: %s is %s", ErrBoxNotRunning, boxID, info.State)
	}
}
