package boxlite

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/transport"
)

const gvproxyTunnelTimeout = 10 * time.Second

func (c *Client) NewGuestPortTransport(boxId string, port uint16, logger *slog.Logger) *http.Transport {
	if logger == nil {
		logger = slog.Default()
	}

	return &http.Transport{
		ForceAttemptHTTP2: false,
		DialContext: func(ctx context.Context, network string, addr string) (net.Conn, error) {
			if network != "tcp" && network != "tcp4" && network != "tcp6" {
				return nil, fmt.Errorf("unsupported network %q", network)
			}

			conn, err := c.DialGuestPort(ctx, boxId, port)
			if err != nil {
				logger.WarnContext(ctx, "guest port tunnel failed", "box", boxId, "port", port, "error", err)
				return nil, err
			}
			return conn, nil
		},
	}
}

func (c *Client) DialGuestPort(ctx context.Context, boxId string, port uint16) (net.Conn, error) {
	servicesSocketPath, guestIP, err := c.GvproxyServicesEndpoint(ctx, boxId)
	if err != nil {
		return nil, err
	}

	return dialGvproxyTunnel(ctx, servicesSocketPath, guestIP, port)
}

func dialGvproxyTunnel(ctx context.Context, servicesSocketPath string, guestIP string, port uint16) (net.Conn, error) {
	if guestIP == "" {
		return nil, fmt.Errorf("guest IP is required")
	}

	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "unix", servicesSocketPath)
	if err != nil {
		return nil, fmt.Errorf("dial gvproxy tunnel socket %s: %w", servicesSocketPath, err)
	}

	deadline := time.Now().Add(gvproxyTunnelTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		_ = conn.Close()
		return nil, err
	}

	if err := transport.Tunnel(conn, guestIP, int(port)); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open gvproxy tunnel to %s:%d: %w", guestIP, port, err)
	}

	if err := conn.SetDeadline(time.Time{}); err != nil {
		_ = conn.Close()
		return nil, err
	}

	return conn, nil
}
