// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

// Package boxlite provides a BoxLite-backed implementation of the sandbox runtime,
// replacing Docker with VM-based isolation via the BoxLite Go SDK.
package boxlite

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-labs/runner/pkg/api/dto"
	"github.com/boxlite-labs/runner/pkg/models/enums"
	"github.com/containerd/errdefs"
)

// Client wraps the BoxLite Go SDK to provide the same interface as the Docker client.
// It manages VMs instead of containers, providing hardware-level isolation.
type Client struct {
	runtime            *boxlite.Runtime
	logger             *slog.Logger
	insecureRegistries []string
	mu                 sync.RWMutex
	boxes              map[string]*boxlite.Box
	awsRegion          string
	awsEndpointUrl     string
	awsAccessKeyId     string
	awsSecretAccessKey string
	volumeMutexes      map[string]*sync.Mutex
	volumeMutexesMutex sync.Mutex
	volumeCleanupMutex sync.Mutex
	lastVolumeCleanup  time.Time
	volumeCleanup      volumeCleanupConfig
}

// ClientConfig holds configuration for the BoxLite client.
type ClientConfig struct {
	Logger                       *slog.Logger
	HomeDir                      string
	InsecureRegistries           []string
	AWSRegion                    string
	AWSEndpointUrl               string
	AWSAccessKeyId               string
	AWSSecretAccessKey           string
	VolumeCleanupInterval        time.Duration
	VolumeCleanupDryRun          bool
	VolumeCleanupExclusionPeriod time.Duration
}

func networkSpec(blockAll *bool, allowList *string) boxlite.NetworkSpec {
	if blockAll != nil && *blockAll {
		return boxlite.NetworkSpec{Mode: boxlite.NetworkModeDisabled}
	}

	spec := boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled}
	if allowList == nil {
		return spec
	}

	for _, entry := range strings.Split(*allowList, ",") {
		entry = strings.TrimSpace(entry)
		if entry != "" {
			spec.AllowNet = append(spec.AllowNet, entry)
		}
	}
	return spec
}

// NewClient creates a new BoxLite client backed by the BoxLite VM runtime.
func NewClient(ctx context.Context, config ClientConfig) (*Client, error) {
	var opts []boxlite.RuntimeOption
	if config.HomeDir != "" {
		opts = append(opts, boxlite.WithHomeDir(config.HomeDir))
	}
	insecureRegistries := normalizeRegistryHosts(config.InsecureRegistries)
	if len(insecureRegistries) > 0 {
		registries := make([]boxlite.ImageRegistry, 0, len(insecureRegistries))
		for _, host := range insecureRegistries {
			registries = append(registries, boxlite.ImageRegistry{
				Host:       host,
				Transport:  boxlite.RegistryTransportHTTP,
				SkipVerify: true,
			})
		}
		opts = append(opts, boxlite.WithImageRegistries(registries...))
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
		runtime:            rt,
		logger:             logger,
		insecureRegistries: insecureRegistries,
		boxes:              make(map[string]*boxlite.Box),
		awsRegion:          config.AWSRegion,
		awsEndpointUrl:     config.AWSEndpointUrl,
		awsAccessKeyId:     config.AWSAccessKeyId,
		awsSecretAccessKey: config.AWSSecretAccessKey,
		volumeMutexes:      make(map[string]*sync.Mutex),
		volumeCleanup: volumeCleanupConfig{
			interval:        config.VolumeCleanupInterval,
			dryRun:          config.VolumeCleanupDryRun,
			exclusionPeriod: config.VolumeCleanupExclusionPeriod,
		},
	}, nil
}

// Close shuts down the BoxLite runtime and releases all resources.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	for id, bx := range c.boxes {
		bx.Close()
		delete(c.boxes, id)
	}
	return c.runtime.Close()
}

// Create creates a new sandbox (VM) from the given image and configuration.
// Returns the box ID and daemon version.
func (c *Client) Create(ctx context.Context, sandboxDto dto.CreateSandboxDTO) (string, string, error) {
	cpus := int(sandboxDto.CpuQuota / 100_000)
	if cpus < 1 {
		cpus = 1
	}
	memoryMiB := int(sandboxDto.MemoryQuota / (1024 * 1024))
	if memoryMiB < 128 {
		memoryMiB = 128
	}
	opts := []boxlite.BoxOption{
		boxlite.WithName(sandboxDto.Id),
		boxlite.WithCPUs(cpus),
		boxlite.WithMemory(memoryMiB),
		boxlite.WithAutoRemove(false),
		boxlite.WithDetach(true),
	}
	if sandboxDto.StorageQuota > 0 {
		c.logger.DebugContext(ctx, "storage quota ignored because the Go SDK does not expose disk sizing", "sandbox", sandboxDto.Id)
	}

	for k, v := range sandboxDto.Env {
		opts = append(opts, boxlite.WithEnv(k, v))
	}

	if len(sandboxDto.Entrypoint) > 0 {
		opts = append(opts, boxlite.WithEntrypoint(sandboxDto.Entrypoint...))
	}

	volumeMounts, err := c.getVolumeMounts(ctx, sandboxDto.Volumes)
	if err != nil {
		return "", "", err
	}
	for _, vol := range volumeMounts {
		opts = append(opts, boxlite.WithVolume(vol.hostPath, vol.mountPath))
	}

	if len(volumeMounts) > 0 {
		if err := c.recordSandboxVolumeMounts(ctx, sandboxDto.Id, volumeMounts); err != nil {
			return "", "", err
		}
	}

	opts = append(opts, boxlite.WithNetwork(networkSpec(sandboxDto.NetworkBlockAll, sandboxDto.NetworkAllowList)))

	bx, err := c.runtime.Create(ctx, sandboxDto.Snapshot, opts...)
	if err != nil {
		if len(volumeMounts) > 0 {
			if cleanupErr := c.removeSandboxVolumeMountRecord(ctx, sandboxDto.Id); cleanupErr != nil {
				c.logger.WarnContext(ctx, "failed to remove sandbox volume mount record after create failure", "sandbox", sandboxDto.Id, "error", cleanupErr)
			}
		}
		return "", "", fmt.Errorf("failed to create box: %w", err)
	}

	c.mu.Lock()
	c.boxes[sandboxDto.Id] = bx
	c.mu.Unlock()

	c.logger.Info("created box", "id", bx.ID(), "name", bx.Name(), "image", sandboxDto.Snapshot)

	skipStart := sandboxDto.SkipStart != nil && *sandboxDto.SkipStart
	if !skipStart {
		if err := bx.Start(ctx); err != nil {
			return bx.ID(), "", fmt.Errorf("failed to start box: %w", err)
		}
	}

	return bx.ID(), "boxlite", nil
}

// Start starts a stopped sandbox and returns the daemon version.
func (c *Client) Start(ctx context.Context, sandboxId string, authToken *string, metadata map[string]string) (string, error) {
	if err := c.ensureVolumeMountsFromMetadata(ctx, sandboxId, metadata); err != nil {
		c.logger.ErrorContext(ctx, "failed to ensure volume FUSE mounts", "error", err)
	}

	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return "", err
	}
	if err := bx.Start(ctx); err != nil {
		return "", err
	}
	return "boxlite", nil
}

// Stop stops a running sandbox.
func (c *Client) Stop(ctx context.Context, sandboxId string, force bool) error {
	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return err
	}
	err = bx.Stop(ctx)

	c.mu.Lock()
	delete(c.boxes, sandboxId)
	c.mu.Unlock()

	return err
}

// Destroy removes a sandbox entirely.
func (c *Client) Destroy(ctx context.Context, sandboxId string) error {
	c.mu.Lock()
	if bx, ok := c.boxes[sandboxId]; ok {
		bx.Close()
		delete(c.boxes, sandboxId)
	}
	c.mu.Unlock()

	if err := c.runtime.ForceRemove(ctx, sandboxId); err != nil {
		return err
	}

	if err := c.removeSandboxVolumeMountRecord(ctx, sandboxId); err != nil {
		c.logger.WarnContext(ctx, "failed to remove sandbox volume mount record", "sandbox", sandboxId, "error", err)
	}
	c.CleanupOrphanedVolumeMounts(ctx)

	return nil
}

// GetSandboxState returns the current state of a sandbox.
func (c *Client) GetSandboxState(ctx context.Context, sandboxId string) (enums.SandboxState, error) {
	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		if boxlite.IsNotFound(err) {
			return enums.SandboxStateUnknown, nil
		}
		return enums.SandboxStateUnknown, err
	}

	info, err := bx.Info(ctx)
	if err != nil {
		return enums.SandboxStateUnknown, err
	}

	switch info.State {
	case boxlite.StateRunning:
		return enums.SandboxStateStarted, nil
	case boxlite.StateStopped:
		return enums.SandboxStateStopped, nil
	case boxlite.StateConfigured:
		return enums.SandboxStateCreating, nil
	default:
		return enums.SandboxStateUnknown, nil
	}
}

// StartExecution starts an interactive execution in a sandbox.
func (c *Client) StartExecution(ctx context.Context, sandboxId string, command string, args []string, stdout, stderr io.Writer, tty bool) (*boxlite.Execution, error) {
	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return nil, err
	}
	return bx.StartExecution(ctx, command, args, &boxlite.ExecutionOptions{
		TTY:    tty,
		Stdout: stdout,
		Stderr: stderr,
	})
}

// Exec executes a command in a running sandbox and returns the result.
func (c *Client) Exec(ctx context.Context, sandboxId string, command string, args ...string) (*ExecResult, error) {
	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return nil, err
	}

	result, err := bx.Exec(ctx, command, args...)
	if err != nil {
		return nil, err
	}

	return &ExecResult{
		StdOut:   result.Stdout,
		StdErr:   result.Stderr,
		ExitCode: result.ExitCode,
	}, nil
}

// CopyInto copies a file from host into a sandbox.
func (c *Client) CopyInto(ctx context.Context, sandboxId string, hostSrc, guestDst string) error {
	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return err
	}
	return bx.CopyInto(ctx, hostSrc, guestDst)
}

// CopyOut copies a file from a sandbox to the host.
func (c *Client) CopyOut(ctx context.Context, sandboxId string, guestSrc, hostDst string) error {
	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return err
	}
	return bx.CopyOut(ctx, guestSrc, hostDst)
}

// PullImage pulls an OCI image into the runtime's cache.
func (c *Client) PullImage(ctx context.Context, imageName string) error {
	c.logger.Info("pulling image", "image", imageName)
	images, err := c.runtime.Images()
	if err != nil {
		return err
	}
	defer images.Close()
	_, err = images.Pull(ctx, imageName)
	return err
}

// RemoveImage removes a cached image.
func (c *Client) RemoveImage(ctx context.Context, imageName string, force bool) error {
	c.logger.Warn("remove image not yet implemented in BoxLite", "image", imageName)
	return errdefs.ErrNotImplemented.WithMessage("image removal is not supported by the BoxLite Go SDK")
}

// ImageExists checks if an image is cached locally.
func (c *Client) ImageExists(ctx context.Context, imageName string) (bool, error) {
	images, err := c.ListImages(ctx)
	if err != nil {
		return false, err
	}
	for _, img := range images {
		if img.Reference == imageName || img.Repository+":"+img.Tag == imageName {
			return true, nil
		}
	}
	return false, nil
}

// GetImageInfo returns metadata about a cached image.
func (c *Client) GetImageInfoFromCache(ctx context.Context, imageName string) (*boxlite.ImageInfo, error) {
	images, err := c.ListImages(ctx)
	if err != nil {
		return nil, err
	}
	for _, img := range images {
		if img.Reference == imageName || img.Repository+":"+img.Tag == imageName {
			return &img, nil
		}
	}
	return nil, fmt.Errorf("image not found: %s", imageName)
}

// ListImages returns all locally cached images.
func (c *Client) ListImages(ctx context.Context) ([]boxlite.ImageInfo, error) {
	images, err := c.runtime.Images()
	if err != nil {
		return nil, err
	}
	defer images.Close()
	return images.List(ctx)
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
	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return nil, err
	}
	return bx.Metrics(ctx)
}

// ListInfo returns info for all boxes managed by this runtime.
func (c *Client) ListInfo(ctx context.Context) ([]boxlite.BoxInfo, error) {
	return c.runtime.ListInfo(ctx)
}

// GetBox retrieves a box handle from cache or fetches it from the runtime.
func (c *Client) GetBox(ctx context.Context, sandboxId string) (*boxlite.Box, error) {
	return c.getOrFetchBox(ctx, sandboxId)
}

// getOrFetchBox retrieves a box handle from cache or fetches it from the runtime.
func (c *Client) getOrFetchBox(ctx context.Context, sandboxId string) (*boxlite.Box, error) {
	c.mu.RLock()
	bx, ok := c.boxes[sandboxId]
	c.mu.RUnlock()

	if ok {
		return bx, nil
	}

	bx, err := c.runtime.Get(ctx, sandboxId)
	if err != nil {
		return nil, fmt.Errorf("box %s not found: %w", sandboxId, err)
	}

	c.mu.Lock()
	c.boxes[sandboxId] = bx
	c.mu.Unlock()

	return bx, nil
}

// ExecResult holds the output of a command execution.
type ExecResult struct {
	StdOut   string
	StdErr   string
	ExitCode int
}
