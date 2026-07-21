// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

// Package boxlite provides a BoxLite-backed implementation of the box runtime,
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
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
	"go.opentelemetry.io/otel/propagation"
)

// Client wraps the BoxLite Go SDK to provide the same interface as the Docker client.
// It manages VMs instead of containers, providing hardware-level isolation.
type Client struct {
	runtime            *boxlite.Runtime
	logger             *slog.Logger
	homeDir            string
	mu                 sync.RWMutex
	boxes              map[string]*boxlite.Box
	awsRegion          string
	awsEndpointUrl     string
	awsAccessKeyId     string
	awsSecretAccessKey string
	volumeBucketPrefix string
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
	GhcrUsername                 string
	GhcrToken                    string
	DockerHubUsername            string
	DockerHubToken               string
	AWSRegion                    string
	AWSEndpointUrl               string
	AWSAccessKeyId               string
	AWSSecretAccessKey           string
	VolumeBucketPrefix           string
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

func boxRuntimeEnv(ctx context.Context, boxDto dto.CreateBoxDTO) map[string]string {
	env := map[string]string{
		"BOXLITE_BOX_ID": boxDto.Id,
	}
	if boxDto.OtelEndpoint != nil && *boxDto.OtelEndpoint != "" {
		env["BOXLITE_OTEL_ENDPOINT"] = *boxDto.OtelEndpoint
	}
	if boxDto.OrganizationId != nil && *boxDto.OrganizationId != "" {
		env["BOXLITE_ORGANIZATION_ID"] = *boxDto.OrganizationId
	}
	if boxDto.RegionId != nil && *boxDto.RegionId != "" {
		env["BOXLITE_REGION_ID"] = *boxDto.RegionId
	}
	// Propagate the active W3C trace context into the box so in-box processes can
	// join the SAME traceId as the api->runner spans, instead of rooting a fresh
	// disjoint trace. With no active span the carrier is empty.
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	if traceParent := carrier.Get("traceparent"); traceParent != "" {
		env["BOXLITE_TRACEPARENT"] = traceParent
		if traceState := carrier.Get("tracestate"); traceState != "" {
			env["BOXLITE_TRACESTATE"] = traceState
		}
	}
	return env
}

// buildImageRegistries assembles the runtime-scoped OCI registry list handed to boxlite-core:
// the existing insecure (HTTP, no-auth) registries, plus — when ghcr credentials are provided —
// a single authenticated ghcr.io HTTPS entry so core can pull our private first-party images
// directly from ghcr (no self-hosted registry mirror required). Auth is runtime-scoped because
// boxlite.Runtime.Create has no per-call credential parameter. When ghcrUsername/ghcrToken are
// empty this is byte-for-byte the previous behavior (anonymous), so it is safe to ship dark.
// Kept as a pure function so the wiring can be unit-tested without constructing a real runtime.
func buildImageRegistries(insecureRegistries []string, ghcrUsername, ghcrToken string) []boxlite.ImageRegistry {
	registries := make([]boxlite.ImageRegistry, 0, len(insecureRegistries)+1)
	for _, host := range insecureRegistries {
		registries = append(registries, boxlite.ImageRegistry{
			Host:       host,
			Transport:  boxlite.RegistryTransportHTTP,
			SkipVerify: true,
		})
	}
	if ghcrUsername != "" && ghcrToken != "" {
		registries = append(registries, boxlite.ImageRegistry{
			Host:      "ghcr.io",
			Transport: boxlite.RegistryTransportHTTPS,
			Auth: boxlite.ImageRegistryAuth{
				Username: ghcrUsername,
				Password: ghcrToken,
			},
		})
	}
	return registries
}

// NewClient creates a new BoxLite client backed by the BoxLite VM runtime.
func NewClient(ctx context.Context, config ClientConfig) (*Client, error) {
	if strings.TrimSpace(config.VolumeBucketPrefix) == "" {
		return nil, fmt.Errorf("VOLUME_BUCKET_PREFIX is required")
	}

	var opts []boxlite.RuntimeOption
	if config.HomeDir != "" {
		opts = append(opts, boxlite.WithHomeDir(config.HomeDir))
	}
	insecureRegistries := normalizeRegistryHosts(config.InsecureRegistries)
	registries := buildImageRegistries(insecureRegistries, config.GhcrUsername, config.GhcrToken)
	// docker.io auth (local dev): boxlite-core pulls box base images (e.g. the
	// debian base disk + public user images) from docker.io; without auth those
	// hit the anonymous Docker Hub rate limit. Mirror the ghcr.io auth entry.
	if config.DockerHubUsername != "" && config.DockerHubToken != "" {
		registries = append(registries, boxlite.ImageRegistry{
			Host:      "docker.io",
			Transport: boxlite.RegistryTransportHTTPS,
			Auth: boxlite.ImageRegistryAuth{
				Username: config.DockerHubUsername,
				Password: config.DockerHubToken,
			},
		})
	}
	if len(registries) > 0 {
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
		homeDir:            config.HomeDir,
		boxes:              make(map[string]*boxlite.Box),
		awsRegion:          config.AWSRegion,
		awsEndpointUrl:     config.AWSEndpointUrl,
		awsAccessKeyId:     config.AWSAccessKeyId,
		awsSecretAccessKey: config.AWSSecretAccessKey,
		volumeBucketPrefix: config.VolumeBucketPrefix,
		volumeMutexes:      make(map[string]*sync.Mutex),
		volumeCleanup: volumeCleanupConfig{
			interval:        config.VolumeCleanupInterval,
			dryRun:          config.VolumeCleanupDryRun,
			exclusionPeriod: config.VolumeCleanupExclusionPeriod,
		},
	}, nil
}

// Shutdown gracefully stops all running boxes in the underlying BoxLite
// runtime. Blocks until shutdown completes or `timeout` elapses. Call this
// BEFORE Close so VMs aren't killed mid-write on systemd SIGTERM.
//
// Without this, restart attempts for the killed boxes hit a 30s
// `guest_connect` timeout because the guest agent inside never re-establishes
// vsock after an unclean shutdown — and (until the matching Rust-side fix
// landed) that timeout would auto-delete the box record.
//
// `timeout=0` means "use the runtime default (10s)". Negative values are
// clamped by the SDK.
func (c *Client) Shutdown(ctx context.Context, timeout time.Duration) error {
	return c.runtime.Shutdown(ctx, timeout)
}

// Close releases the BoxLite runtime handle. Prefer calling `Shutdown` first
// so boxes get a graceful stop before the C handle is freed.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	for id, bx := range c.boxes {
		bx.Close()
		delete(c.boxes, id)
	}
	return c.runtime.Close()
}

// Create creates a new box (VM) from the given image and configuration.
// Returns the box ID and runtime version.
func (c *Client) Create(ctx context.Context, boxDto dto.CreateBoxDTO) (string, string, error) {
	// API sends cores / GB / GB as small integers (see apps/api Box entity).
	cpus := int(boxDto.CpuQuota)
	if cpus < 1 {
		cpus = 1
	}
	memoryMiB := int(boxDto.MemoryQuota * 1024)
	if memoryMiB < 128 {
		memoryMiB = 128
	}
	opts := []boxlite.BoxOption{
		boxlite.WithName(boxDto.Id),
		boxlite.WithCPUs(cpus),
		boxlite.WithMemory(memoryMiB),
		boxlite.WithAutoRemove(false),
		boxlite.WithDetach(true),
	}
	if boxDto.StorageQuota > 0 {
		opts = append(opts, boxlite.WithDiskSize(int(boxDto.StorageQuota)))
	}

	for k, v := range boxDto.Env {
		opts = append(opts, boxlite.WithEnv(k, v))
	}
	for k, v := range boxRuntimeEnv(ctx, boxDto) {
		opts = append(opts, boxlite.WithEnv(k, v))
	}

	if len(boxDto.Entrypoint) > 0 {
		opts = append(opts, boxlite.WithEntrypoint(boxDto.Entrypoint...))
	}

	volumeMounts, err := c.getVolumeMounts(ctx, boxDto.Volumes)
	if err != nil {
		return "", "", err
	}
	for _, vol := range volumeMounts {
		opts = append(opts, boxlite.WithVolume(vol.hostPath, vol.mountPath))
	}

	if len(volumeMounts) > 0 {
		if err := c.recordBoxVolumeMounts(ctx, boxDto.Id, volumeMounts); err != nil {
			return "", "", err
		}
	}

	opts = append(opts, boxlite.WithNetwork(networkSpec(boxDto.NetworkBlockAll, boxDto.NetworkAllowList)))

	// GetOrCreate (not Create) so a CREATE_BOX replay is idempotent. The local
	// box name is boxDto.Id — the control plane's globally-unique box id — so if
	// the box was already persisted by a prior CREATE_BOX for the SAME box (e.g.
	// the host rebooted before the job was marked COMPLETED and the poller is
	// replaying the still-IN_PROGRESS job), the core adopts it instead of
	// failing with "already exists", which the API would surface as a 400.
	// The created flag (new vs adopted) is irrelevant here: either way the box
	// now exists locally and the job can proceed, so it is discarded.
	bx, _, err := c.runtime.GetOrCreate(ctx, boxDto.Image, opts...)
	if err != nil {
		if len(volumeMounts) > 0 {
			if cleanupErr := c.removeBoxVolumeMountRecord(ctx, boxDto.Id); cleanupErr != nil {
				c.logger.WarnContext(ctx, "failed to remove box volume mount record after create failure", "box", boxDto.Id, "error", cleanupErr)
			}
		}
		return "", "", fmt.Errorf("failed to create box: %w", err)
	}

	c.mu.Lock()
	c.boxes[boxDto.Id] = bx
	c.mu.Unlock()

	c.logger.Info(
		"created box",
		"id",
		bx.ID(),
		"boxId",
		boxDto.Id,
		"name",
		bx.Name(),
		"image",
		boxDto.Image,
	)

	skipStart := boxDto.SkipStart != nil && *boxDto.SkipStart
	if !skipStart {
		if err := bx.Start(ctx); err != nil {
			return bx.ID(), "", fmt.Errorf("failed to start box: %w", err)
		}
	}

	return bx.ID(), "boxlite", nil
}

// Start starts a stopped box and returns the runtime version.
func (c *Client) Start(ctx context.Context, boxId string, authToken *string, metadata map[string]string) (string, error) {
	if err := c.ensureVolumeMountsFromMetadata(ctx, boxId, metadata); err != nil {
		c.logger.ErrorContext(ctx, "failed to ensure volume FUSE mounts", "error", err)
	}

	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return "", err
	}
	if err := bx.Start(ctx); err != nil {
		return "", err
	}
	return "boxlite", nil
}

// Stop stops a running box.
func (c *Client) Stop(ctx context.Context, boxId string, force bool) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	err = bx.Stop(ctx)

	c.mu.Lock()
	delete(c.boxes, boxId)
	c.mu.Unlock()

	return err
}

// Destroy removes a box entirely.
func (c *Client) Destroy(ctx context.Context, boxId string) error {
	c.mu.Lock()
	if bx, ok := c.boxes[boxId]; ok {
		bx.Close()
		delete(c.boxes, boxId)
	}
	c.mu.Unlock()

	if err := c.runtime.ForceRemove(ctx, boxId); err != nil {
		return err
	}

	if err := c.removeBoxVolumeMountRecord(ctx, boxId); err != nil {
		c.logger.WarnContext(ctx, "failed to remove box volume mount record", "box", boxId, "error", err)
	}
	c.CleanupOrphanedVolumeMounts(ctx)

	return nil
}

// GetBoxState returns the current state of a box.
func (c *Client) GetBoxState(ctx context.Context, boxId string) (enums.BoxState, error) {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		if boxlite.IsNotFound(err) {
			return enums.BoxStateUnknown, nil
		}
		return enums.BoxStateUnknown, err
	}

	info, err := bx.Info(ctx)
	if err != nil {
		return enums.BoxStateUnknown, err
	}

	switch info.State {
	case boxlite.StateRunning:
		return enums.BoxStateStarted, nil
	case boxlite.StateStopped:
		return enums.BoxStateStopped, nil
	case boxlite.StateConfigured:
		return enums.BoxStateCreating, nil
	default:
		return enums.BoxStateUnknown, nil
	}
}

// StartExecution starts an interactive execution in a box.
func (c *Client) StartExecution(ctx context.Context, boxId string, command string, args []string, stdout, stderr io.Writer, tty bool) (*boxlite.Execution, error) {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return nil, err
	}
	return bx.StartExecution(ctx, command, args, &boxlite.ExecutionOptions{
		TTY:    tty,
		Stdout: stdout,
		Stderr: stderr,
	})
}

// Exec executes a command in a running box and returns the result.
func (c *Client) Exec(ctx context.Context, boxId string, command string, args ...string) (*ExecResult, error) {
	bx, err := c.getOrFetchBox(ctx, boxId)
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

// CopyInto copies a file from host into a box.
func (c *Client) CopyInto(ctx context.Context, boxId string, hostSrc, guestDst string) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	return bx.CopyInto(ctx, hostSrc, guestDst)
}

// CopyOut copies a file from a box to the host.
func (c *Client) CopyOut(ctx context.Context, boxId string, guestSrc, hostDst string) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	return bx.CopyOut(ctx, guestSrc, hostDst)
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

// BoxMetrics returns metrics for a specific box.
func (c *Client) BoxMetrics(ctx context.Context, boxId string) (*boxlite.BoxMetrics, error) {
	bx, err := c.getOrFetchBox(ctx, boxId)
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
func (c *Client) GetBox(ctx context.Context, boxId string) (*boxlite.Box, error) {
	return c.getOrFetchBox(ctx, boxId)
}

// getOrFetchBox retrieves a box handle from cache or fetches it from the runtime.
func (c *Client) getOrFetchBox(ctx context.Context, boxId string) (*boxlite.Box, error) {
	c.mu.RLock()
	bx, ok := c.boxes[boxId]
	c.mu.RUnlock()

	if ok {
		return bx, nil
	}

	bx, err := c.runtime.Get(ctx, boxId)
	if err != nil {
		return nil, fmt.Errorf("box %s not found: %w", boxId, err)
	}

	c.mu.Lock()
	c.boxes[boxId] = bx
	c.mu.Unlock()

	return bx, nil
}

// ExecResult holds the output of a command execution.
type ExecResult struct {
	StdOut   string
	StdErr   string
	ExitCode int
}
