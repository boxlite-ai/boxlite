package boxlite

import (
	"context"
	"errors"
	"fmt"
	"net"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// ErrBoxNotRunning is returned for a box that is not up by the calls that must
// not boot it: DialGuestPort and the SSH controls.
var ErrBoxNotRunning = errors.New("box is not running")

// runningBox returns the handle of a running box, or ErrBoxNotRunning.
//
// A fresh handle boots its box on first use, so a guest call used to start a
// stopped box behind the control plane's back: the box served traffic while
// the API still recorded it as stopped.
//
// A stopped box is refused from the runtime's persisted state, before any
// handle is fetched: fetching one for a stopped box evicts and leaks a handle,
// and the proxy retries the dial every 500 ms (see evictBox). The state is then
// checked again on the handle the caller uses. A handle that was attached when
// its box stopped is spent and fails instead of booting, so a stop landing
// between the two checks cannot restart the box. Known gap, accepted: a fresh
// handle (first call after a runner restart) whose box exits on its own in
// that window is still booted by that call.
func (c *Client) runningBox(ctx context.Context, boxID string) (*boxlite.Box, error) {
	info, err := c.runtime.GetInfo(ctx, boxID)
	if err != nil {
		return nil, fmt.Errorf("read state of box %s: %w", boxID, err)
	}
	if !guestDialable(info.State) {
		return nil, fmt.Errorf("%w: %s is %s", ErrBoxNotRunning, boxID, info.State)
	}
	if c.afterGuestStateCheck != nil {
		c.afterGuestStateCheck(boxID)
	}

	bx, err := c.getOrFetchBox(ctx, boxID)
	if err != nil {
		return nil, err
	}
	// Info reads persisted state; it never boots the box.
	handleInfo, err := bx.Info(ctx)
	if err != nil {
		return nil, fmt.Errorf("read state of box %s: %w", boxID, err)
	}
	if !guestDialable(handleInfo.State) {
		return nil, fmt.Errorf("%w: %s is %s", ErrBoxNotRunning, boxID, handleInfo.State)
	}
	return bx, nil
}

// DialGuestPort opens a raw TCP stream to a port inside a running box.
// The proxy handles ErrBoxNotRunning by asking the API to resume the box.
func (c *Client) DialGuestPort(ctx context.Context, boxID string, port uint16) (net.Conn, error) {
	bx, err := c.runningBox(ctx, boxID)
	if err != nil {
		return nil, err
	}

	network, err := bx.Network()
	if err != nil {
		return nil, fmt.Errorf("open box network handle for %s: %w", boxID, err)
	}
	defer network.Close()

	tunnel, err := network.Tunnel(ctx, &net.TCPAddr{Port: int(port)}, boxlite.DefaultTunnelOptions())
	if err != nil {
		return nil, fmt.Errorf("prepare guest TCP tunnel to %s port %d: %w", boxID, port, err)
	}

	conn, err := tunnel.Connect(ctx)
	if err != nil {
		return nil, fmt.Errorf("connect guest TCP tunnel to %s port %d: %w", boxID, port, err)
	}
	return conn, nil
}

// guestDialable reports whether a guest port can answer now. A paused box is
// frozen for a snapshot: a dial would hang until it thaws, so it is refused
// like a stopped box and the proxy retries until the box runs again.
func guestDialable(state boxlite.State) bool {
	return state == boxlite.StateRunning
}
