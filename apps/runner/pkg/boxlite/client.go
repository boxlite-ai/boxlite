// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 Daytona Platforms Inc.
// Modified and rebranded for BoxLite

// Package boxlite provides a BoxLite-backed implementation of the sandbox runtime,
// replacing Docker with VM-based isolation via the BoxLite Go SDK.
package boxlite

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/daytonaio/runner/pkg/docker/dto"
	"github.com/daytonaio/runner/pkg/enums"
)

// Client wraps the BoxLite Go SDK to provide the same interface as the Docker client.
// It manages VMs instead of containers, providing hardware-level isolation.
type Client struct {
	runtime *boxlite.Runtime
	logger  *slog.Logger
	mu      sync.RWMutex
	// Track box handles by sandbox ID for quick lookup
	boxes map[string]*boxlite.Box
}

// ClientConfig holds configuration for the BoxLite client.
type ClientConfig struct {
	Logger  *slog.Logger
	HomeDir string
}

// NewClient creates a new BoxLite client backed by the BoxLite VM runtime.
func NewClient(ctx context.Context, config ClientConfig) (*Client, error) {
	var opts []boxlite.RuntimeOption
	if config.HomeDir != "" {
		opts = append(opts, boxlite.WithHomeDir(config.HomeDir))
	}

	rt, err := boxlite.NewRuntime(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create boxlite runtime: %w", err)
	}

	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}

	return &Client{
		runtime: rt,
		logger:  logger,
		boxes:   make(map[string]*boxlite.Box),
	}, nil
}

// Close shuts down the BoxLite runtime and releases all resources.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	for id, box := range c.boxes {
		box.Close()
		delete(c.boxes, id)
	}
	return c.runtime.Close()
}

// Create creates a new sandbox (VM) from the given image and configuration.
// Returns the box ID and daemon version.
func (c *Client) Create(ctx context.Context, sandboxDto dto.CreateSandboxDTO) (string, string, error) {
	opts := []boxlite.BoxOption{
		boxlite.WithName(sandboxDto.Id),
		boxlite.WithCPUs(int(sandboxDto.CpuQuota)),
		boxlite.WithMemory(int(sandboxDto.MemoryQuota) * 1024), // GB to MiB
	}

	for k, v := range sandboxDto.Env {
		opts = append(opts, boxlite.WithEnv(k, v))
	}

	if sandboxDto.Entrypoint != nil && len(sandboxDto.Entrypoint) > 0 {
		opts = append(opts, boxlite.WithEntrypoint(sandboxDto.Entrypoint...))
	}

	box, err := c.runtime.Create(ctx, sandboxDto.Snapshot, opts...)
	if err != nil {
		return "", "", fmt.Errorf("failed to create box: %w", err)
	}

	c.mu.Lock()
	c.boxes[sandboxDto.Id] = box
	c.mu.Unlock()

	c.logger.Info("created box", "id", box.ID(), "name", box.Name(), "image", sandboxDto.Snapshot)

	skipStart := sandboxDto.SkipStart != nil && *sandboxDto.SkipStart
	if !skipStart {
		if err := box.Start(ctx); err != nil {
			return box.ID(), "", fmt.Errorf("failed to start box: %w", err)
		}
	}

	return box.ID(), "boxlite", nil
}

// Start starts a stopped sandbox.
func (c *Client) Start(ctx context.Context, sandboxId string) error {
	box, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return err
	}
	return box.Start(ctx)
}

// Stop stops a running sandbox.
func (c *Client) Stop(ctx context.Context, sandboxId string, force bool) error {
	box, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return err
	}
	return box.Stop(ctx)
}

// Destroy removes a sandbox entirely.
func (c *Client) Destroy(ctx context.Context, sandboxId string) error {
	c.mu.Lock()
	if box, ok := c.boxes[sandboxId]; ok {
		box.Close()
		delete(c.boxes, sandboxId)
	}
	c.mu.Unlock()

	return c.runtime.Remove(ctx, sandboxId)
}

// GetSandboxState returns the current state of a sandbox.
func (c *Client) GetSandboxState(ctx context.Context, sandboxId string) (enums.SandboxState, error) {
	box, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		if boxlite.IsNotFound(err) {
			return enums.SandboxStateUnknown, nil
		}
		return enums.SandboxStateUnknown, err
	}

	info, err := box.Info(ctx)
	if err != nil {
		return enums.SandboxStateUnknown, err
	}

	switch info.State {
	case "running":
		return enums.SandboxStateStarted, nil
	case "stopped":
		return enums.SandboxStateStopped, nil
	case "configured":
		return enums.SandboxStateCreating, nil
	default:
		return enums.SandboxStateUnknown, nil
	}
}

// Exec executes a command in a running sandbox and returns the result.
func (c *Client) Exec(ctx context.Context, sandboxId string, command string, args ...string) (*ExecResult, error) {
	box, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return nil, err
	}

	result, err := box.Exec(ctx, command, args...)
	if err != nil {
		return nil, err
	}

	return &ExecResult{
		StdOut:   result.Stdout,
		StdErr:   result.Stderr,
		ExitCode: result.ExitCode,
	}, nil
}

// PullImage pulls an OCI image into the runtime's cache.
func (c *Client) PullImage(ctx context.Context, imageName string) error {
	// BoxLite auto-pulls images during Create, but we can pre-pull
	// by creating and immediately removing a box.
	// TODO: Add dedicated PullImage to BoxLite Go SDK
	c.logger.Info("pull image requested", "image", imageName)
	return nil
}

// RemoveImage removes a cached image.
func (c *Client) RemoveImage(ctx context.Context, imageName string, force bool) error {
	// TODO: Add image management to BoxLite Go SDK
	c.logger.Warn("remove image not yet implemented in BoxLite", "image", imageName)
	return nil
}

// ImageExists checks if an image is cached locally.
func (c *Client) ImageExists(ctx context.Context, imageName string) (bool, error) {
	// TODO: Add image query to BoxLite Go SDK
	return false, nil
}

// Ping checks if the BoxLite runtime is healthy.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.runtime.Metrics(ctx)
	return err
}

// Metrics returns runtime-level metrics.
func (c *Client) Metrics(ctx context.Context) (*boxlite.RuntimeMetrics, error) {
	return c.runtime.Metrics(ctx)
}

// BoxMetrics returns metrics for a specific sandbox.
func (c *Client) BoxMetrics(ctx context.Context, sandboxId string) (*boxlite.BoxMetrics, error) {
	box, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return nil, err
	}
	return box.Metrics(ctx)
}

// getOrFetchBox retrieves a box handle from cache or fetches it from the runtime.
func (c *Client) getOrFetchBox(ctx context.Context, sandboxId string) (*boxlite.Box, error) {
	c.mu.RLock()
	box, ok := c.boxes[sandboxId]
	c.mu.RUnlock()

	if ok {
		return box, nil
	}

	box, err := c.runtime.Get(ctx, sandboxId)
	if err != nil {
		return nil, fmt.Errorf("box %s not found: %w", sandboxId, err)
	}

	c.mu.Lock()
	c.boxes[sandboxId] = box
	c.mu.Unlock()

	return box, nil
}

// ExecResult holds the output of a command execution.
type ExecResult struct {
	StdOut   string
	StdErr   string
	ExitCode int
}
