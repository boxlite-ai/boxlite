// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	ToolboxGuestPort     = 2280
	toolboxPortRecordDir = ".boxlite-toolbox-ports"
)

type toolboxPortRecord struct {
	BoxID     string `json:"boxId"`
	GuestPort int    `json:"guestPort"`
	HostPort  int    `json:"hostPort"`
}

func (c *Client) reserveToolboxHostPort(ctx context.Context, boxID string) (int, error) {
	c.toolboxPortMutex.Lock()
	defer c.toolboxPortMutex.Unlock()

	if port, err := c.readToolboxHostPort(boxID); err == nil {
		return port, nil
	}

	port, err := findAvailableLocalPort()
	if err != nil {
		return 0, err
	}

	record := toolboxPortRecord{
		BoxID:     boxID,
		GuestPort: ToolboxGuestPort,
		HostPort:  port,
	}
	if err := c.writeToolboxPortRecord(record); err != nil {
		return 0, err
	}

	c.logger.InfoContext(ctx, "reserved toolbox host port", "box", boxID, "guestPort", ToolboxGuestPort, "hostPort", port)
	return port, nil
}

// ToolboxHostPort returns the host port that forwards to the box toolbox.
func (c *Client) ToolboxHostPort(boxID string) (int, error) {
	c.toolboxPortMutex.Lock()
	defer c.toolboxPortMutex.Unlock()

	return c.readToolboxHostPort(boxID)
}

func (c *Client) removeToolboxPortRecord(ctx context.Context, boxID string) error {
	c.toolboxPortMutex.Lock()
	defer c.toolboxPortMutex.Unlock()

	path := c.toolboxPortRecordPath(boxID)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}

	c.logger.DebugContext(ctx, "removed toolbox port record", "box", boxID)
	return nil
}

func (c *Client) readToolboxHostPort(boxID string) (int, error) {
	data, err := os.ReadFile(c.toolboxPortRecordPath(boxID))
	if err != nil {
		return 0, err
	}

	var record toolboxPortRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return 0, err
	}

	if record.BoxID != boxID {
		return 0, fmt.Errorf("toolbox port record box mismatch: got %q, want %q", record.BoxID, boxID)
	}
	if record.GuestPort != ToolboxGuestPort {
		return 0, fmt.Errorf("toolbox port record guest port mismatch: got %d, want %d", record.GuestPort, ToolboxGuestPort)
	}
	if record.HostPort < 1 || record.HostPort > 65535 {
		return 0, fmt.Errorf("toolbox port record has invalid host port %d", record.HostPort)
	}

	return record.HostPort, nil
}

func (c *Client) writeToolboxPortRecord(record toolboxPortRecord) error {
	dir := c.toolboxPortRecordDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	data, err := json.Marshal(record)
	if err != nil {
		return err
	}

	path := c.toolboxPortRecordPath(record.BoxID)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (c *Client) toolboxPortRecordPath(boxID string) string {
	return filepath.Join(c.toolboxPortRecordDir(), safeRecordName(boxID)+".json")
}

func (c *Client) toolboxPortRecordDir() string {
	if c.homeDir != "" {
		return filepath.Join(c.homeDir, toolboxPortRecordDir)
	}

	cacheDir, err := os.UserCacheDir()
	if err == nil && cacheDir != "" {
		return filepath.Join(cacheDir, "boxlite-runner", toolboxPortRecordDir)
	}

	return filepath.Join(os.TempDir(), "boxlite-runner", toolboxPortRecordDir)
}

func findAvailableLocalPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("failed to reserve local toolbox port: %w", err)
	}
	defer listener.Close()

	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok || addr.Port < 1 || addr.Port > 65535 {
		return 0, fmt.Errorf("invalid local toolbox port address %q", listener.Addr().String())
	}

	return addr.Port, nil
}

func safeRecordName(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_':
			b.WriteRune(r)
		default:
			b.WriteString("-" + strconv.FormatInt(int64(r), 16))
		}
	}
	return b.String()
}
