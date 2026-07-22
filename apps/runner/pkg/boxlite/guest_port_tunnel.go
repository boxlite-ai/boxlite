package boxlite

import (
	"context"
	"fmt"
	"net"
)

func (c *Client) DialGuestPort(ctx context.Context, boxID string, port uint16) (net.Conn, error) {
	bx, err := c.getOrFetchBox(ctx, boxID)
	if err != nil {
		return nil, err
	}

	network, err := bx.Network()
	if err != nil {
		return nil, fmt.Errorf("open box network handle for %s: %w", boxID, err)
	}
	defer network.Close()

	tunnel, err := network.Tunnel(ctx, port)
	if err != nil {
		return nil, fmt.Errorf("prepare guest TCP tunnel to %s port %d: %w", boxID, port, err)
	}

	conn, err := tunnel.Connect(ctx)
	if err != nil {
		return nil, fmt.Errorf("connect guest TCP tunnel to %s port %d: %w", boxID, port, err)
	}
	return conn, nil
}
