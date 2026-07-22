package boxlite

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"
)

const (
	guestPortTransportIdleTTL = 5 * time.Minute
	guestPortTransportLimit   = 128
)

type guestPortTransportKey struct {
	boxId string
	port  uint16
}

type guestPortTransportEntry struct {
	transport *http.Transport
	lastUsed  time.Time
}

// GuestPortTransport returns a pooled transport for a box service endpoint.
func (c *Client) GuestPortTransport(boxId string, port uint16, logger *slog.Logger) *http.Transport {
	now := time.Now()
	key := guestPortTransportKey{boxId: boxId, port: port}

	c.portTransportMu.Lock()
	defer c.portTransportMu.Unlock()

	if c.portTransports == nil {
		c.portTransports = make(map[guestPortTransportKey]*guestPortTransportEntry)
	}
	c.evictGuestPortTransportsLocked(now)
	if entry, ok := c.portTransports[key]; ok {
		entry.lastUsed = now
		return entry.transport
	}

	transport := c.NewGuestPortTransport(boxId, port, logger)
	c.portTransports[key] = &guestPortTransportEntry{transport: transport, lastUsed: now}
	return transport
}

func (c *Client) evictGuestPortTransportsLocked(now time.Time) {
	for key, entry := range c.portTransports {
		if now.Sub(entry.lastUsed) >= guestPortTransportIdleTTL {
			entry.transport.CloseIdleConnections()
			delete(c.portTransports, key)
		}
	}

	for len(c.portTransports) >= guestPortTransportLimit {
		var oldestKey guestPortTransportKey
		var oldest *guestPortTransportEntry
		for key, entry := range c.portTransports {
			if oldest == nil || entry.lastUsed.Before(oldest.lastUsed) {
				oldestKey = key
				oldest = entry
			}
		}
		oldest.transport.CloseIdleConnections()
		delete(c.portTransports, oldestKey)
	}
}

func (c *Client) closeGuestPortTransports(boxId string) {
	c.portTransportMu.Lock()
	defer c.portTransportMu.Unlock()

	for key, entry := range c.portTransports {
		if boxId == "" || key.boxId == boxId {
			entry.transport.CloseIdleConnections()
			delete(c.portTransports, key)
		}
	}
}

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
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return nil, err
	}

	network, err := bx.Network()
	if err != nil {
		return nil, fmt.Errorf("open box network handle for %s: %w", boxId, err)
	}
	defer network.Close()

	tunnel, err := network.Tunnel(ctx, port)
	if err != nil {
		return nil, fmt.Errorf("prepare guest TCP tunnel to %s port %d: %w", boxId, port, err)
	}
	defer tunnel.Close()

	conn, err := tunnel.Connect(ctx)
	if err != nil {
		return nil, fmt.Errorf("connect guest TCP tunnel to %s port %d: %w", boxId, port, err)
	}
	return conn, nil
}
